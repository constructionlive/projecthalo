// The summon key, or (until macOS allows it) a button to allow it.

import { api } from '../lib/api';
import { useHotkey } from '../lib/useHalo';

export function HotkeyChip() {
  const hk = useHotkey();
  if (!hk) return null;
  if (!hk.listening) {
    return (
      <button className="btn signal" onClick={() => api.allowHotkey()} title="System Settings → Privacy & Security → Input Monitoring → turn Halo on">
        Allow {hk.label}
      </button>
    );
  }
  const other = hk.key === 'rightCommand' ? 'leftCommand' : 'rightCommand';
  return (
    <button className="btn quiet" onClick={() => api.setSummonKey(other)} title={`Switch to ${other === 'leftCommand' ? 'left' : 'right'} ⌘`}>
      Tap {hk.label} anywhere
    </button>
  );
}
