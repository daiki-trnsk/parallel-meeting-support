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

## 会議音声の録音（実験データ）

同時参加者が「開始」を押すと各エージェントが録音を始め、その同時参加者が room から退出すると終了する。
実験群（CommaDebug, `subject-01`）・統制群（ControlDebug, `subject-control-01`）のどちらでも動く。
画面上部の `REC A` / `REC B` が赤丸付きなら録音中、赤背景の「未開始」なら agent から応答がない。

- 出力: `agent/recordings/{YYYY-MM-DD_HH-MM-SS}_{subject|control}/roomA.wav` / `roomB.wav`（1 セッション 1 ディレクトリ。16kHz・モノラル・room 内の全参加者をミックス）
- 同名の `.json` に開始 epoch（WAV の 0 秒）・終了理由・入退室/ミュートの時刻を記録
- ミュート等で音声が来ない区間は無音で埋めるため、WAV の t 秒 = `start_epoch_ms` + t 秒
- 同じ回で再度開始された場合は `-part2` 以降の別ファイルになる（上書きしない）
- 環境変数: `PMS_RECORD=0` で無効化、`PMS_RECORD_DIR` で保存先変更、`PMS_RECORD_EXCLUDE_IDENTITIES` でミックスから除外、`PMS_RECORD_SUBJECTS`（既定 `subject-01:subject,subject-control-01:control`）で同時参加者と群名の対応を変更

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
