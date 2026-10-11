import React from 'react';

const MUTED_COLOR = '#e53935';
const ACTIVE_COLOR = '#eee';

type Props = {
  enabled: boolean;
  onClick: () => void;
  ariaLabel?: string;
};

/**
 * Mic-only icon button, no label — plain mic glyph when enabled, same glyph
 * in red with a diagonal slash through it when disabled. Purely
 * presentational (driven by props), so it works both wrapped around
 * useLocalParticipant (see MicToggleButton, for the サクラ's own in-room
 * screen) and driven by an external Room reference obtained outside any
 * LiveKit React context (see ControlDebug, whose LiveKitRoom connections are
 * hidden and whose mic state is plain React state).
 */
const MicIconButton: React.FC<Props> = ({ enabled, onClick, ariaLabel }) => {
  const color = enabled ? ACTIVE_COLOR : MUTED_COLOR;

  return (
    <button
      onClick={onClick}
      aria-label={ariaLabel ?? (enabled ? 'マイクをオフにする' : 'マイクをオンにする')}
      style={{
        width: 56,
        height: 56,
        borderRadius: '50%',
        border: `2px solid ${color}`,
        background: '#1a1a1a',
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <svg width={28} height={28} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <rect x="9" y="2" width="6" height="11" rx="3" />
        <path d="M5 10a7 7 0 0 0 14 0" />
        <line x1="12" y1="19" x2="12" y2="22" />
        <line x1="8" y1="22" x2="16" y2="22" />
        {!enabled && <line x1="3" y1="3" x2="21" y2="21" />}
      </svg>
    </button>
  );
};

export default MicIconButton;
