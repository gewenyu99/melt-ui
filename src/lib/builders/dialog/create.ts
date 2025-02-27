import { useFocusTrap, useEscapeKeydown, usePortal } from '$lib/internal/actions/index.js';
import {
	addMeltEventListener,
	makeElement,
	createElHelpers,
	effect,
	executeCallbacks,
	generateIds,
	getPortalDestination,
	handleFocus,
	isBrowser,
	isHTMLElement,
	kbd,
	noop,
	omit,
	overridable,
	removeScroll,
	styleToString,
	toWritableStores,
	portalAttr,
} from '$lib/internal/helpers/index.js';
import { withGet } from '$lib/internal/helpers/withGet.js';
import type { Defaults, MeltActionReturn } from '$lib/internal/types.js';
import { tick } from 'svelte';
import { derived, writable } from 'svelte/store';
import type { DialogEvents } from './events.js';
import type { CreateDialogProps } from './types.js';
import { useModal } from '$lib/internal/actions/modal/action.js';

type DialogParts =
	| 'trigger'
	| 'overlay'
	| 'content'
	| 'title'
	| 'description'
	| 'close'
	| 'portalled';
const { name } = createElHelpers<DialogParts>('dialog');

const defaults = {
	preventScroll: true,
	escapeBehavior: 'close',
	closeOnOutsideClick: true,
	role: 'dialog',
	defaultOpen: false,
	portal: 'body',
	forceVisible: false,
	openFocus: undefined,
	closeFocus: undefined,
	onOutsideClick: undefined,
} satisfies Defaults<CreateDialogProps>;

export const dialogIdParts = ['content', 'title', 'description'] as const;
export type DialogIdParts = typeof dialogIdParts;

export function createDialog(props?: CreateDialogProps) {
	const withDefaults = { ...defaults, ...props } satisfies CreateDialogProps;

	const options = toWritableStores(omit(withDefaults, 'ids'));

	const {
		preventScroll,
		escapeBehavior,
		closeOnOutsideClick,
		role,
		portal,
		forceVisible,
		openFocus,
		closeFocus,
		onOutsideClick,
	} = options;

	const activeTrigger = withGet.writable<HTMLElement | null>(null);

	const ids = toWritableStores({
		...generateIds(dialogIdParts),
		...withDefaults.ids,
	});

	const openWritable = withDefaults.open ?? writable(withDefaults.defaultOpen);
	const open = overridable(openWritable, withDefaults?.onOpenChange);
	const isVisible = derived([open, forceVisible], ([$open, $forceVisible]) => {
		return $open || $forceVisible;
	});

	let unsubScroll = noop;

	function handleOpen(e: Event) {
		const el = e.currentTarget;
		const triggerEl = e.currentTarget;
		if (!isHTMLElement(el) || !isHTMLElement(triggerEl)) return;
		open.set(true);
		activeTrigger.set(triggerEl);
	}

	function handleClose() {
		open.set(false);
	}

	const trigger = makeElement(name('trigger'), {
		stores: [open],
		returned: ([$open]) => {
			return {
				'aria-haspopup': 'dialog',
				'aria-expanded': $open,
				type: 'button',
			} as const;
		},
		action: (node: HTMLElement): MeltActionReturn<DialogEvents['trigger']> => {
			const unsub = executeCallbacks(
				addMeltEventListener(node, 'click', (e) => {
					handleOpen(e);
				}),
				addMeltEventListener(node, 'keydown', (e) => {
					if (e.key !== kbd.ENTER && e.key !== kbd.SPACE) return;
					e.preventDefault();
					handleOpen(e);
				})
			);

			return {
				destroy: unsub,
			};
		},
	});

	const overlay = makeElement(name('overlay'), {
		stores: [isVisible, open],
		returned: ([$isVisible, $open]) => {
			return {
				hidden: $isVisible ? undefined : true,
				tabindex: -1,
				style: $isVisible ? undefined : styleToString({ display: 'none' }),
				'aria-hidden': true,
				'data-state': $open ? 'open' : 'closed',
			} as const;
		},
	});

	const content = makeElement(name('content'), {
		stores: [isVisible, ids.content, ids.description, ids.title, open],
		returned: ([$isVisible, $contentId, $descriptionId, $titleId, $open]) => {
			return {
				id: $contentId,
				role: role.get(),
				'aria-describedby': $descriptionId,
				'aria-labelledby': $titleId,
				'aria-modal': $isVisible ? 'true' : undefined,
				'data-state': $open ? 'open' : 'closed',
				tabindex: -1,
				hidden: $isVisible ? undefined : true,
				style: $isVisible ? undefined : styleToString({ display: 'none' }),
			} as const;
		},

		action: (node: HTMLElement) => {
			let unsubEscape = noop;
			let unsubModal = noop;
			let unsubFocusTrap = noop;

			const unsubDerived = effect(
				[isVisible, closeOnOutsideClick],
				([$isVisible, $closeOnOutsideClick]) => {
					unsubModal();
					unsubEscape();
					unsubFocusTrap();
					if (!$isVisible) return;

					unsubModal = useModal(node, {
						closeOnInteractOutside: $closeOnOutsideClick,
						onClose: handleClose,
						shouldCloseOnInteractOutside(e) {
							onOutsideClick.get()?.(e);
							if (e.defaultPrevented) return false;
							return true;
						},
					}).destroy;

					unsubEscape = useEscapeKeydown(node, {
						handler: handleClose,
						behaviorType: escapeBehavior,
					}).destroy;

					unsubFocusTrap = useFocusTrap(node, { fallbackFocus: node }).destroy;
				}
			);

			return {
				destroy: () => {
					unsubScroll();
					unsubDerived();
					unsubModal();
					unsubEscape();
					unsubFocusTrap();
				},
			};
		},
	});

	const portalled = makeElement(name('portalled'), {
		stores: portal,
		returned: ($portal) =>
			({
				'data-portal': portalAttr($portal),
			} as const),
		action: (node: HTMLElement) => {
			const unsubPortal = effect([portal], ([$portal]) => {
				if ($portal === null) return noop;
				const portalDestination = getPortalDestination(node, $portal);
				if (portalDestination === null) return noop;
				return usePortal(node, portalDestination).destroy;
			});

			return {
				destroy() {
					unsubPortal();
				},
			};
		},
	});

	const title = makeElement(name('title'), {
		stores: [ids.title],
		returned: ([$titleId]) =>
			({
				id: $titleId,
			} as const),
	});

	const description = makeElement(name('description'), {
		stores: [ids.description],
		returned: ([$descriptionId]) =>
			({
				id: $descriptionId,
			} as const),
	});

	const close = makeElement(name('close'), {
		returned: () =>
			({
				type: 'button',
			} as const),
		action: (node: HTMLElement): MeltActionReturn<DialogEvents['close']> => {
			const unsub = executeCallbacks(
				addMeltEventListener(node, 'click', () => {
					handleClose();
				}),
				addMeltEventListener(node, 'keydown', (e) => {
					if (e.key !== kbd.SPACE && e.key !== kbd.ENTER) return;
					e.preventDefault();
					handleClose();
				})
			);

			return {
				destroy: unsub,
			};
		},
	});

	effect([open, preventScroll], ([$open, $preventScroll]) => {
		if (!isBrowser) return;

		if ($preventScroll && $open) unsubScroll = removeScroll();

		if ($open) {
			const contentEl = document.getElementById(ids.content.get());
			handleFocus({ prop: openFocus.get(), defaultEl: contentEl });
		}

		return () => {
			// we only want to remove the scroll lock if the dialog is not forced visible
			// otherwise the scroll removal is handled in the `destroy` of the `content` builder
			if (!forceVisible.get()) {
				unsubScroll();
			}
		};
	});

	effect(
		open,
		($open) => {
			if (!isBrowser || $open) return;
			handleFocus({
				prop: closeFocus.get(),
				defaultEl: activeTrigger.get(),
			});
		},
		{ skipFirstRun: true }
	);

	return {
		ids,
		elements: {
			content,
			trigger,
			title,
			description,
			overlay,
			close,
			portalled,
		},
		states: {
			open,
		},
		options,
	};
}
