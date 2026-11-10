import { useId } from "react";
import {
  Button,
  Dialog,
  Heading,
  Modal,
  ModalOverlay,
} from "react-aria-components";
import {
  ACTION_LABELS,
  DIALOGS,
  isRisky,
  PENDING_LABELS,
  programLines,
  ROW_PROGRAMS,
  type RiskyAction,
  type SessionAction,
} from "../shared/session-actions.js";
import type { LeftoverOffer } from "../shared/protocol.js";
import cssClasses from "./App.module.css";
import type { ActionResultView } from "./useSessionActions.js";

const styles = cssClasses as Record<
  | "actions"
  | "button"
  | "dangerButton"
  | "dialog"
  | "dialogButtons"
  | "dialogTarget"
  | "dialogTitle"
  | "leftovers"
  | "leftoversTitle"
  | "modal"
  | "overlay"
  | "result",
  string
>;

export function RowActions({
  actions,
  label,
  pending,
  result,
  onAction,
}: {
  actions: SessionAction[];
  label: string;
  pending: SessionAction | undefined;
  result: ActionResultView | undefined;
  onAction: (action: SessionAction) => void;
}) {
  if (actions.length === 0 && result === undefined) return null;
  return (
    <>
      {actions.length > 0 && (
        <div
          role="group"
          aria-label={`Actions for ${label}`}
          className={styles.actions}
        >
          {actions.map((action) => (
            <Button
              key={action}
              data-action={action}
              className={
                isRisky(action)
                  ? `${styles.button} ${styles.dangerButton}`
                  : styles.button
              }
              isPending={pending === action}
              isDisabled={pending !== undefined && pending !== action}
              onPress={() => {
                onAction(action);
              }}
            >
              {pending === action
                ? PENDING_LABELS[action]
                : isRisky(action)
                  ? `${ACTION_LABELS[action]}…`
                  : ACTION_LABELS[action]}
            </Button>
          ))}
        </div>
      )}
      {result !== undefined && (
        <p className={styles.result} data-outcome={result.reply.outcome}>
          {ACTION_LABELS[result.action]}: {result.reply.message}
        </p>
      )}
    </>
  );
}

/**
 * The programs a session left running, and the button that ends them (FR-27). The programs come
 * from the server's own record; the button names only the session.
 */
export function LeftoverPanel({
  offer,
  label,
  canEnd,
  pending,
  onEnd,
}: {
  offer: LeftoverOffer;
  label: string;
  canEnd: boolean;
  pending: SessionAction | undefined;
  onEnd: () => void;
}) {
  const titleId = useId();
  return (
    <div className={styles.leftovers}>
      <p id={titleId} className={styles.leftoversTitle}>
        Programs still running
      </p>
      <ul aria-labelledby={titleId}>
        {programLines(offer, ROW_PROGRAMS).map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      {canEnd && (
        <div
          role="group"
          aria-label={`Leftover programs of ${label}`}
          className={styles.actions}
        >
          <Button
            data-action="endLeftovers"
            className={`${styles.button} ${styles.dangerButton}`}
            isPending={pending === "endLeftovers"}
            isDisabled={pending !== undefined && pending !== "endLeftovers"}
            onPress={onEnd}
          >
            {pending === "endLeftovers"
              ? PENDING_LABELS.endLeftovers
              : `${ACTION_LABELS.endLeftovers}…`}
          </Button>
        </div>
      )}
    </div>
  );
}

export interface Confirming {
  action: RiskyAction;
  label: string;
}

/**
 * One alert dialog for the page, so a row moving between groups while it's open doesn't close
 * it. It names the session (FR-19), and Cancel has focus, so Enter alone never confirms.
 */
export function ConfirmDialog({
  confirming,
  programs = [],
  onCancel,
  onConfirm,
}: {
  confirming: Confirming | null;
  /** For End leftover programs: the programs, as the latest snapshot lists them. */
  programs?: string[];
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const describedBy = useId();
  const text = confirming === null ? null : DIALOGS[confirming.action];
  return (
    <ModalOverlay
      className={styles.overlay}
      isOpen={confirming !== null}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <Modal className={styles.modal}>
        <Dialog
          role="alertdialog"
          className={styles.dialog}
          aria-describedby={describedBy}
        >
          {text !== null && confirming !== null && (
            <>
              <Heading slot="title" className={styles.dialogTitle}>
                {text.title}
              </Heading>
              <div id={describedBy}>
                <p className={styles.dialogTarget}>{confirming.label}</p>
                {programs.length > 0 && (
                  <ul aria-label="Programs to end">
                    {programs.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                )}
                {text.body.map((paragraph) => (
                  <p key={paragraph}>{paragraph}</p>
                ))}
              </div>
              <div className={styles.dialogButtons}>
                <Button autoFocus className={styles.button} onPress={onCancel}>
                  Cancel
                </Button>
                <Button
                  className={`${styles.button} ${styles.dangerButton}`}
                  onPress={onConfirm}
                >
                  {text.confirm}
                </Button>
              </div>
            </>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
