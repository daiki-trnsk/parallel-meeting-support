# parallel-meeting-support

## 起動手順

### 画面

```bash
cd frontend
npm run dev
```

### エージェント A

```bash
cd agent
.venv\Scripts\activate
set PMS_AGENT_IDENTITY=pms-agent-room-a
python agent.py dev
```

### エージェント B

```bash
cd agent
.venv\Scripts\activate
set PMS_AGENT_IDENTITY=pms-agent-room-b
python agent.py dev
```

## 補助操作

### トークンサーバー確認

起動前または動作確認時に、以下のヘルスチェックを一度叩いておきます。

```text
https://pms-token-server.onrender.com/health
```

### エージェント不参加時

新しいターミナルで次を実行します。

```bash
cd agent
python agent_dispatch.py
```

それでも表示されない場合は、Python プロセスを終了してから再試行します。

```bash
taskkill /f /im python.exe
```

## デプロイ先

```text
https://parallel-meeting-support-coral.vercel.app/
```
