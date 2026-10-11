import React from 'react';
import { useLocalParticipant } from '@livekit/components-react';
import MicIconButton from './MicIconButton';

/**
 * Mic-only control (no camera/chat/leave/screen-share), replacing LiveKit's
 * default ControlBar on the サクラ's own meeting screen — that screen is
 * meant to offer nothing beyond mic on/off.
 */
const MicToggleButton: React.FC = () => {
  const { isMicrophoneEnabled, localParticipant } = useLocalParticipant();

  return (
    <MicIconButton
      enabled={isMicrophoneEnabled}
      onClick={() => {
        localParticipant.setMicrophoneEnabled(!isMicrophoneEnabled).catch((e) => {
          console.error('[meeting] setMicrophoneEnabled failed', e);
        });
      }}
    />
  );
};

export default MicToggleButton;
