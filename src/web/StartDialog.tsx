import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import {
  Button,
  Dialog,
  Heading,
  Input,
  Label,
  Modal,
  ModalOverlay,
  Radio,
  RadioGroup,
  Text,
  TextArea,
  TextField,
} from "react-aria-components";
import type { ActionReply } from "../shared/session-actions.js";
import cssClasses from "./App.module.css";
import {
  postAction,
  readFolderListing,
  type FolderListingView,
  type SessionKind,
} from "./api.js";

const styles = cssClasses as Record<
  | "button"
  | "dialog"
  | "dialogButtons"
  | "dialogTarget"
  | "dialogTitle"
  | "field"
  | "fieldHelp"
  | "folderList"
  | "folderPanel"
  | "formError"
  | "input"
  | "modal"
  | "overlay"
  | "radio"
  | "radios",
  string
>;

/** Limits the server checks again (C-17). */
export const MAX_NAME = 100;
export const MAX_PROMPT = 8000;

/** What both forms send, apart from where the session runs. */
interface SessionFields {
  kind: SessionKind;
  name?: string;
  prompt?: string;
}

function fieldsOf(kind: SessionKind, name: string, prompt: string) {
  const fields: SessionFields = { kind };
  if (name !== "") fields.name = name;
  if (kind === "background") fields.prompt = prompt;
  return fields;
}

/** Kind, name, and prompt, shared by New session and Fork (FR-32, FR-33). */
function SessionOptions({
  kind,
  setKind,
  name,
  setName,
  prompt,
  setPrompt,
  disabled,
}: {
  kind: SessionKind;
  setKind: (kind: SessionKind) => void;
  name: string;
  setName: (name: string) => void;
  prompt: string;
  setPrompt: (prompt: string) => void;
  disabled: boolean;
}) {
  return (
    <>
      <RadioGroup
        className={styles.field}
        value={kind}
        onChange={(value) => {
          setKind(value === "interactive" ? "interactive" : "background");
        }}
        isDisabled={disabled}
      >
        <Label>Kind</Label>
        <div className={styles.radios}>
          <Radio value="background" className={styles.radio}>
            Background, with a prompt
          </Radio>
          <Radio value="interactive" className={styles.radio}>
            In a new terminal
          </Radio>
        </div>
      </RadioGroup>
      <TextField
        className={styles.field}
        value={name}
        onChange={setName}
        maxLength={MAX_NAME}
        isDisabled={disabled}
      >
        <Label>Name (optional)</Label>
        <Input className={styles.input} autoComplete="off" spellCheck={false} />
        <Text slot="description" className={styles.fieldHelp}>
          Up to {MAX_NAME} characters, without %. A terminal session can only be
          named when Windows Terminal is installed.
        </Text>
      </TextField>
      {kind === "background" && (
        <TextField
          className={styles.field}
          value={prompt}
          onChange={setPrompt}
          maxLength={MAX_PROMPT}
          isRequired
          isDisabled={disabled}
        >
          <Label>Prompt</Label>
          <TextArea
            className={styles.input}
            rows={4}
            autoComplete="off"
            spellCheck={false}
          />
          <Text slot="description" className={styles.fieldHelp}>
            What the session should do, up to {MAX_PROMPT} characters.
          </Text>
        </TextField>
      )}
    </>
  );
}

/** The folder one level up, or null at a drive root. */
export function parentFolder(folder: string): string | null {
  const trimmed = folder.replace(/[\\/]+$/, "");
  const at = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
  if (at < 0) return null;
  const parent = trimmed.slice(0, at);
  return /^[A-Za-z]:$/.test(parent) ? `${parent}\\` : parent;
}

function joinFolder(folder: string, name: string): string {
  return /[\\/]$/.test(folder) ? `${folder}${name}` : `${folder}\\${name}`;
}

/** Lists local folders through the server, for picking one (FR-32). */
function FolderBrowser({
  start,
  onPick,
}: {
  start: string;
  onPick: (folder: string) => void;
}) {
  const [listing, setListing] = useState<FolderListingView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const current = useRef<HTMLParagraphElement>(null);
  const moved = useRef(false);
  const latest = useRef(0);

  const load = async (folder: string | undefined) => {
    latest.current += 1;
    const ticket = latest.current;
    setLoading(true);
    const { reply, data } = await postAction({
      action: "listFolders",
      ...(folder === undefined || folder === "" ? {} : { folder }),
    });
    if (ticket !== latest.current) return;
    setLoading(false);
    if (reply.outcome !== "succeeded") {
      setError(reply.message);
      return;
    }
    setError(null);
    setListing(readFolderListing(data));
  };

  useEffect(() => {
    void load(start);
    // Only the folder typed when Browse was opened.
  }, []);

  // Moving to another folder replaces the buttons, so focus goes to the folder's name.
  useEffect(() => {
    if (moved.current && !loading) current.current?.focus();
  }, [listing, loading]);

  const open = (folder: string) => {
    moved.current = true;
    void load(folder);
  };

  const folder = listing?.folder ?? null;
  const parent = folder === null ? null : parentFolder(folder);
  return (
    <div className={styles.folderPanel}>
      {error !== null && (
        <p role="alert" className={styles.formError}>
          {error}
        </p>
      )}
      {loading && <p role="status">Listing folders…</p>}
      {listing !== null && (
        <>
          <p ref={current} tabIndex={-1} className={styles.dialogTarget}>
            {folder ?? "No folder"}
          </p>
          <div className={styles.dialogButtons}>
            {parent !== null && (
              <Button
                className={styles.button}
                isDisabled={loading}
                onPress={() => {
                  open(parent);
                }}
              >
                Up one level
              </Button>
            )}
            {folder !== null && (
              <Button
                className={styles.button}
                onPress={() => {
                  onPick(folder);
                }}
              >
                Use this folder
              </Button>
            )}
          </div>
          {listing.drives.length > 0 && (
            <ul aria-label="Drives" className={styles.folderList}>
              {listing.drives.map((drive) => (
                <li key={drive}>
                  <Button
                    className={styles.button}
                    isDisabled={loading}
                    onPress={() => {
                      open(drive);
                    }}
                  >
                    {drive}
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {folder !== null && (
            <ul
              aria-label={`Folders in ${folder}`}
              className={styles.folderList}
            >
              {listing.folders.length === 0 && <li>No folders here.</li>}
              {listing.folders.map((name) => (
                <li key={name}>
                  <Button
                    className={styles.button}
                    isDisabled={loading}
                    onPress={() => {
                      open(joinFolder(folder, name));
                    }}
                  >
                    {name}
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {listing.truncated && (
            <p className={styles.fieldHelp}>
              Only the first {listing.folders.length} folders are shown. Type
              the folder instead.
            </p>
          )}
        </>
      )}
    </div>
  );
}

/** What a form reports once the server has answered. */
export type OnStarted = (reply: ActionReply) => void;

function useSubmit(onStarted: OnStarted) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (body: Record<string, unknown>) => {
    setPending(true);
    setError(null);
    const { reply } = await postAction(body);
    setPending(false);
    if (reply.outcome === "started" || reply.outcome === "succeeded") {
      onStarted(reply);
    } else {
      setError(reply.message);
    }
  };
  return { pending, error, submit };
}

function DialogShell({
  isOpen,
  onClose,
  title,
  pending,
  children,
}: {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  /** While a start is pending, the dialog stays open for its result. */
  pending: boolean;
  children: React.ReactNode;
}) {
  return (
    <ModalOverlay
      className={styles.overlay}
      isOpen={isOpen}
      isDismissable={false}
      isKeyboardDismissDisabled={pending}
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <Modal className={styles.modal}>
        <Dialog className={styles.dialog}>
          <Heading slot="title" className={styles.dialogTitle}>
            {title}
          </Heading>
          {children}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

/** New session (FR-32): the form is the confirmation (0024). */
export function NewSessionDialog({
  isOpen,
  onClose,
  onStarted,
}: {
  isOpen: boolean;
  onClose: () => void;
  onStarted: OnStarted;
}) {
  const [folder, setFolder] = useState("");
  const [browsing, setBrowsing] = useState(false);
  const [kind, setKind] = useState<SessionKind>("background");
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const { pending, error, submit } = useSubmit(onStarted);
  const folderInput = useRef<HTMLInputElement>(null);
  const errorId = useId();

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    void submit({
      action: "start",
      folder: folder.trim(),
      ...fieldsOf(kind, name, prompt),
    });
  };

  return (
    <DialogShell
      isOpen={isOpen}
      onClose={onClose}
      title="New session"
      pending={pending}
    >
      <form onSubmit={onSubmit} aria-describedby={error ? errorId : undefined}>
        <TextField
          className={styles.field}
          value={folder}
          onChange={setFolder}
          isRequired
          isDisabled={pending}
          autoFocus
        >
          <Label>Folder</Label>
          <Input
            ref={folderInput}
            className={styles.input}
            autoComplete="off"
            spellCheck={false}
          />
          <Text slot="description" className={styles.fieldHelp}>
            A local folder. Network folders aren&apos;t allowed.
          </Text>
        </TextField>
        <div className={styles.dialogButtons}>
          <Button
            className={styles.button}
            aria-expanded={browsing}
            isDisabled={pending}
            onPress={() => {
              setBrowsing((open) => !open);
            }}
          >
            {browsing ? "Close folder list" : "Browse…"}
          </Button>
        </div>
        {browsing && (
          <FolderBrowser
            start={folder.trim()}
            onPick={(picked) => {
              setFolder(picked);
              setBrowsing(false);
              folderInput.current?.focus();
            }}
          />
        )}
        <SessionOptions
          kind={kind}
          setKind={setKind}
          name={name}
          setName={setName}
          prompt={prompt}
          setPrompt={setPrompt}
          disabled={pending}
        />
        {error !== null && (
          <p id={errorId} role="alert" className={styles.formError}>
            {error}
          </p>
        )}
        <div className={styles.dialogButtons}>
          <Button
            className={styles.button}
            isDisabled={pending}
            onPress={onClose}
          >
            Cancel
          </Button>
          <Button type="submit" className={styles.button} isPending={pending}>
            {pending ? "Starting…" : "Start session"}
          </Button>
        </div>
      </form>
    </DialogShell>
  );
}

/** What Fork needs to name its session: the key the server finds it by, and labels. */
export interface ForkTargetView {
  key: string;
  label: string;
  folder: string | null;
}

/** Fork (FR-33): runs in the session's own folder, so it has no folder field (0025). */
export function ForkDialog({
  target,
  onClose,
  onStarted,
}: {
  target: ForkTargetView | null;
  onClose: () => void;
  onStarted: OnStarted;
}) {
  const [kind, setKind] = useState<SessionKind>("background");
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const { pending, error, submit } = useSubmit(onStarted);
  const errorId = useId();

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (target === null) return;
    void submit({
      action: "fork",
      key: target.key,
      ...fieldsOf(kind, name, prompt),
    });
  };

  return (
    <DialogShell
      isOpen={target !== null}
      onClose={onClose}
      title="Fork session"
      pending={pending}
    >
      {target !== null && (
        <form
          onSubmit={onSubmit}
          aria-describedby={error ? errorId : undefined}
        >
          <p className={styles.dialogTarget}>{target.label}</p>
          <p>
            A new session starts with this conversation so far. The original
            isn&apos;t changed.
          </p>
          <p>Folder: {target.folder ?? "the session's recorded folder"}</p>
          <SessionOptions
            kind={kind}
            setKind={setKind}
            name={name}
            setName={setName}
            prompt={prompt}
            setPrompt={setPrompt}
            disabled={pending}
          />
          {error !== null && (
            <p id={errorId} role="alert" className={styles.formError}>
              {error}
            </p>
          )}
          <div className={styles.dialogButtons}>
            <Button
              className={styles.button}
              isDisabled={pending}
              onPress={onClose}
            >
              Cancel
            </Button>
            <Button type="submit" className={styles.button} isPending={pending}>
              {pending ? "Forking…" : "Fork session"}
            </Button>
          </div>
        </form>
      )}
    </DialogShell>
  );
}
