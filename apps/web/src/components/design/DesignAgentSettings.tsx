import { useEffect, useState, type ReactNode } from 'react';
import './design-agent.css';
import {
  call,
  errorText,
  RUNTIME_LABEL,
  RUNTIMES,
  type DesignAgentSettingsDto,
  type RuntimeId,
} from './useDesignJobs.ts';

/** What Atlas never does with any runtime; shown on the consent screen and in docs/design.md. */
export const NEVER_SENT = [
  'whole files, the repository or its history: only names, relations and redacted excerpts of at most 400 characters',
  'secrets: excerpts are redacted before they leave the daemon, and your API key is never shown or logged',
  'file, shell or web access: the agent can only call the Atlas tools',
  'anything on its own: a job runs only when you click Generate or an Ask action',
];

/**
 * One-time consent for a runtime that sends data off this machine (D02, plan §4). Recording
 * consent is its own click; it never starts a job.
 */
export function ConsentScreen({
  runtime,
  sends,
  busy,
  onAgree,
  onCancel,
}: {
  runtime: RuntimeId;
  sends: string;
  busy?: boolean;
  onAgree(): void;
  onCancel?(): void;
}) {
  return (
    <section className="da-consent" role="region" aria-label="Consent">
      <h3>Before Atlas uses {RUNTIME_LABEL[runtime]}</h3>
      <p>
        <strong>What is sent.</strong> {sends}
      </p>
      <p>
        <strong>Never sent or done:</strong>
      </p>
      <ul>
        {NEVER_SENT.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ul>
      <p className="muted small">
        Everything the agent proposes lands as proposed and labeled with its model until you accept
        it. Every job is recorded as a run in Outputs &amp; Audit. You can withdraw consent here at
        any time.
      </p>
      <div className="da-buttons">
        <button type="button" className="action-sm primary" disabled={busy} onClick={onAgree}>
          I agree: allow {RUNTIME_LABEL[runtime]}
        </button>
        {onCancel && (
          <button type="button" className="action-sm" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </section>
  );
}

/** Settings → Design agent: runtime, model, API key (write-only) and consent. */
export function DesignAgentSettings({
  token,
  settings,
  onSaved,
}: {
  token: string;
  settings: DesignAgentSettingsDto | null;
  onSaved(s: DesignAgentSettingsDto): void;
}) {
  const [consentFor, setConsentFor] = useState<RuntimeId>();
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  useEffect(() => {
    setModel(settings?.model ?? '');
  }, [settings?.model]);

  if (!settings) return <p className="muted">Loading design-agent settings…</p>;

  const put = async (body: Record<string, unknown>, done?: string) => {
    setBusy(true);
    setMessage(undefined);
    try {
      const r = await call<DesignAgentSettingsDto>(token, 'PUT', '/settings/design-agent', body);
      if (!r.ok) setMessage(errorText(r));
      else {
        onSaved(r.body);
        if (done) setMessage(done);
      }
      return r.ok;
    } finally {
      setBusy(false);
    }
  };

  const choose = (rt: RuntimeId) => {
    setMessage(undefined);
    if (rt !== 'mock' && !settings.consented[rt]) setConsentFor(rt);
    else {
      setConsentFor(undefined);
      void put({ runtime: rt });
    }
  };

  const revoke = async (rt: RuntimeId) => {
    // consent:false applies to the runtime in the same request; the active runtime falls back to mock
    const keep = settings.runtime === rt ? 'mock' : settings.runtime;
    if (await put({ runtime: rt, consent: false })) await put({ runtime: keep });
  };

  return (
    <div className="da-settings">
      <fieldset className="da-runtimes">
        <legend>Runtime</legend>
        {RUNTIMES.map((rt) => {
          const a = settings.availability[rt];
          return (
            <label key={rt} className={`da-runtime${settings.runtime === rt ? ' on' : ''}`}>
              <input
                type="radio"
                name="design-runtime"
                checked={settings.runtime === rt}
                disabled={busy}
                onChange={() => choose(rt)}
              />
              <span className="da-runtime-body">
                <span className="da-runtime-name">
                  {RUNTIME_LABEL[rt]}
                  {rt === 'claude-code' && <span className="tag">default when available</span>}
                </span>
                <span className={a?.available ? 'da-avail ok' : 'da-avail no'}>
                  {a?.available ? 'available' : 'unavailable'}: {a?.detail}
                </span>
                <span className="muted small">
                  {rt === 'mock'
                    ? 'Nothing leaves this machine.'
                    : settings.consented[rt]
                      ? 'Consent recorded.'
                      : 'Needs your consent before first use.'}
                  {rt !== 'mock' && settings.consented[rt] && (
                    <button
                      type="button"
                      className="link"
                      disabled={busy}
                      onClick={() => void revoke(rt)}
                    >
                      withdraw consent
                    </button>
                  )}
                </span>
              </span>
            </label>
          );
        })}
      </fieldset>

      {consentFor && (
        <ConsentScreen
          runtime={consentFor}
          sends={settings.sends[consentFor]}
          busy={busy}
          onAgree={() =>
            void put({ runtime: consentFor, consent: true }, 'Consent recorded.').then(
              (ok) => ok && setConsentFor(undefined),
            )
          }
          onCancel={() => setConsentFor(undefined)}
        />
      )}

      <label className="field">
        <span className="field-label">Model</span>
        <span className="da-row">
          <input
            aria-label="Model"
            value={model}
            placeholder={settings.runtime === 'mock' ? 'mock-design' : 'runtime default'}
            onChange={(e) => setModel(e.target.value)}
          />
          <button
            type="button"
            className="action-sm"
            disabled={busy}
            onClick={() => void put({ model: model.trim() || null }, 'Model saved.')}
          >
            Save model
          </button>
        </span>
      </label>

      <label className="field">
        <span className="field-label">Anthropic API key</span>
        <span className="da-row">
          <input
            aria-label="Anthropic API key"
            type="password"
            autoComplete="off"
            value={apiKey}
            placeholder={settings.hasApiKey ? 'key stored' : 'sk-ant-…'}
            onChange={(e) => setApiKey(e.target.value)}
          />
          <button
            type="button"
            className="action-sm"
            disabled={busy || !apiKey.trim()}
            onClick={() =>
              void put({ apiKey: apiKey.trim() }, 'Key stored.').then((ok) => ok && setApiKey(''))
            }
          >
            Store key
          </button>
        </span>
        <span className="muted small" role="status" aria-label="API key status">
          {settings.hasApiKey
            ? 'key stored (write-only: it is never shown again or logged)'
            : 'no key stored'}
        </span>
      </label>

      <p className="muted small">
        Prompt template {settings.promptTemplateVersion}. Claude Code runs the official{' '}
        <code>claude -p</code> headless CLI with your own login; Atlas never reads its tokens.
      </p>
      {message && (
        <p className="muted small" role="status">
          {message}
        </p>
      )}
    </div>
  );
}

/** Modal wrapper: Settings with its Design agent section. */
export function SettingsDialog({
  token,
  settings,
  onSaved,
  onClose,
}: {
  token: string;
  settings: DesignAgentSettingsDto | null;
  onSaved(s: DesignAgentSettingsDto): void;
  onClose(): void;
}) {
  return (
    <Modal label="Settings" onClose={onClose}>
      <h2>Settings</h2>
      <section aria-label="Design agent">
        <h3 className="da-h">Design agent</h3>
        <p className="muted small">
          Runs copilot Ask actions and Generate design. Atlas never calls a model without your
          click.
        </p>
        <DesignAgentSettings token={token} settings={settings} onSaved={onSaved} />
      </section>
    </Modal>
  );
}

export function Modal({
  label,
  onClose,
  children,
  wide,
}: {
  label: string;
  onClose(): void;
  children: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="da-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`da-modal${wide ? ' wide' : ''}`} role="dialog" aria-modal aria-label={label}>
        <button type="button" className="icon-btn da-close" aria-label="Close" onClick={onClose}>
          ×
        </button>
        {children}
      </div>
    </div>
  );
}
