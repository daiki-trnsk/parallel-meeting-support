# 技術構成詳細

### システム概要

複数Web会議並行参加における認知負荷軽減・応答支援システム
- 2つのWeb会議に同時参加しながら、内容理解と低遅延応答を支援
- 統制群（支援なし）vs 実験群（支援あり）で効果を定量・定性評価

---

### インフラ構成

```
【Vercel】
  Reactアプリ配信

      ↕ HTTPS

【同時参加者PC(×1)・サクラPC(×4)】

      ↕ WebRTC

【LiveKit Cloud】
  メディアサーバー（SFU）
  ・国内ノード自動選択

      ↕ WebRTC・WebSocket（音声トラック・制御指示・字幕）

【Agentサーバー】
  VPS
  ・LiveKit CloudのAgentリージョンに日本がないため自前起動
  ・VPS：さくらVPS等 日本リージョン

      ↕ HTTPS

【Deepgram API】
  ・STT（音声→テキスト）
```

---

### 技術スタック

#### フロントエンド

| 項目 | 選定 | 備考 |
|------|------|------|
| フレームワーク | React (Vite) | LiveKit公式サンプルがReactベース |
| WebRTC SDK | LiveKit JS SDK | 公式 |
| 倍速処理 | MediaRecorder + playbackRate=2.0 | ブラウザAPI、CPU負荷少？ |
| 字幕表示 | HTMLオーバーレイ |  |
| デプロイ | Vercel |  |

#### バックエンド（Agent）

| 項目 | 選定 | 備考 |
|------|------|------|
| 言語 | Python | LiveKit Agent SDKがPython専用 |
| Agent SDK | LiveKit Agent SDK | 音声トラック処理・制御指示送信を一括管理 |
| STT | Deepgram Nova-3 | 遅延〜150ms、日本語◎ |
| 呼びかけ検知 | キーワードマッチ | STT結果に名前が含まれるか判定、LLM不要 |
| デプロイ | VPS | 未定。低遅延重視 |

#### WebRTC中継

| 項目 | 選定 | 備考 |
|------|------|------|
| SFU | LiveKit Cloud | 日本ノード自動選択 |
| Agentリージョン | 自前起動（ローカル or VPS） | Cloud側に日本リージョンなし |

---

### 映像品質設定

| 用途 | 解像度 | FPS | ビットレート |
|------|--------|-----|------------|
| 通常視聴（リアルタイム） | 360p | 15fps | 〜200kbps |
| バッファ映像（倍速再生用） | 240p | 10fps | 〜80kbps |

---

### 呼びかけ遅延内訳（推定）

| 遅延要因 | 推定値 |
|---------|-------:|
| 参加者→SFU | 5〜20 ms |
| SFU→Agent | 10〜30 ms |
| Agent→Deepgram | 5〜20 ms |
| Deepgram 音声認識 | 100〜250 ms |
| キーワード判定 | <1 ms |
| 制御メッセージ送信 | 5〜20 ms |
| クライアント反映 | 10〜30 ms |

---

**合計:** 135〜370 ms  
**想定中央値:** 約200 ms

---

### 借りるサービス・費用

| サービス | 用途 | 費用 |
|---------|------|------|
| Vercel | フロント配信 | 無料枠 |
| LiveKit Cloud | WebRTC SFU | 無料枠or微課金 |
| Deepgram | STT API | 微課金 |
| VPS（さくら等） | Agent実行 | 微課金 |

---