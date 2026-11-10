// Modal window on the native <dialog>: focus stays inside, Esc closes, the page behind is inert.
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { IconClose } from './Icons';

export default function Modal({
  open,
  title,
  closeLabel,
  onClose,
  children,
  className,
}: {
  open: boolean;
  title: string;
  closeLabel: string;
  onClose: () => void;
  children: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      const back = document.activeElement as HTMLElement | null;
      d.showModal();
      return () => {
        if (d.open) d.close();
        back?.focus?.();
      };
    }
  }, [open]);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    const onCancel = (e: Event) => {
      e.preventDefault();
      onCloseRef.current();
    };
    d.addEventListener('cancel', onCancel);
    return () => d.removeEventListener('cancel', onCancel);
  }, []);

  if (!open) return <dialog ref={ref} className={`modal ${className ?? ''}`} aria-labelledby={titleId} />;
  return (
    <dialog
      ref={ref}
      className={`modal ${className ?? ''}`}
      aria-labelledby={titleId}
      onClick={(e) => {
        // a click on the backdrop (the dialog element itself, outside the panel) closes it
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-panel">
        <div className="modal-head">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="modal-x" onClick={onClose} aria-label={closeLabel}>
            <IconClose />
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </dialog>
  );
}
