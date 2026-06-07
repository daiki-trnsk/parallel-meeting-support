import '@livekit/components-styles';
import {
  LiveKitRoom,
  VideoConference,
} from '@livekit/components-react';

const serverUrl = 'wss://parallel-meeting-support-a7odp0w6.livekit.cloud';
const token = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJleHAiOjE3ODA2NTU4NTgsImlkZW50aXR5IjoiZGFpa2kyIiwiaXNzIjoiQVBJZERoeU02UjY2VEJmIiwibmFtZSI6ImRhaWtpMiIsIm5iZiI6MTc4MDY1NTU1OCwic3ViIjoiZGFpa2kyIiwidmlkZW8iOnsicm9vbSI6InRlc3Qtcm9vbSIsInJvb21Kb2luIjp0cnVlfX0.lpYsZlGAWg_bl5YsrLokdlYbQ7nLQ9YjqL4qXNn5l9k';

function App() {
  return (
    <LiveKitRoom
      serverUrl={serverUrl}
      token={token}
      connect={true}
      video={true}
      audio={true}
    >
      <VideoConference />
    </LiveKitRoom>
  );
}

export default App;