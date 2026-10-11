# 実装内容まとめ

最終更新: 2026-10-06（`develop` ブランチ、コミット `0e1eb3b` 時点のコードを調査して作成）

本ドキュメントは、リポジトリの現在のコードを実際に読んで事実ベースでまとめたものです。
`docs/configuration.md` は構想時点の技術構成一覧であり、本ドキュメントは「実際に何が実装されているか」を記述する。

---

## 1. システムの目的

複数のWeb会議に同時参加する際の認知負荷軽減・応答支援を目的とした卒業研究用の実験システム。
`同時参加者`（実験対象者）が2つの会議（room-a, room-b）に並行参加し、各会議の映像を交互に倍速再生で追いながら、
いずれかの会議で名前を呼ばれた（呼びかけ検知）場合はその会議にリアルタイムで切り替えて応答する、という体験を提供する。

---

## 2. リポジトリ構成

```
parallel-meeting-support/
├── agent/                  # Python製 LiveKit Agent（文字起こし・呼びかけ検知）
│   ├── agent.py
│   └── agent_dispatch.py
├── frontend/               # React (Vite + TypeScript) フロントエンド
│   └── src/
│       ├── pages/          # Home, Meeting, CommaDebug, SpikeTest
│       ├── components/     # CommaTrackBridge, PlaybackController, RealtimeOverlay, DebugReadout, TranscriptPanel
│       ├── hooks/          # useCommaScheduler, useCompositeMeetingStream, useMeetingRecorder, useSubtitleSync, useSummonSignal
│       └── lib/            # codec.ts, sourceBufferQueue.ts, speakerDisplay.ts
└── docs/                   # configuration.md（構想時の技術構成）、本ファイル
```

リポジトリ外の外部依存:
- **LiveKit Cloud**: WebRTC SFU、Agent dispatch
- **トークンサーバー**: `https://pms-token-server.onrender.com`（本リポジトリには実装なし。LiveKit接続トークンを発行するAPI）
- **Deepgram API**: 音声認識（Nova-3, 日本語）
- **Vercel**: フロントエンド配信先（`https://parallel-meeting-support-coral.vercel.app/`）

---

## 3. フロントエンド

技術スタック: React 19 + TypeScript + Vite、`@livekit/components-react` / `livekit-client`、`react-router-dom`。

### 3.1 ルーティング（`App.tsx`）

| パス | コンポーネント | 用途 |
|---|---|---|
| `/` | `Home` | ロール選択・トークン取得 |
| `/meeting` | `Meeting` | 単一会議への通常参加（サクラA〜D用） |
| `/comma-debug` | `CommaDebug` | 2会議並行参加の実験用メイン画面（同時参加者用） |
| `/spike-test` | `SpikeTest` | MSE（MediaRecorder→MediaSource）パイプラインの動作確認用の独立検証ページ |

### 3.2 `Home.tsx` — ロール選択

5つのロールを定義し、ボタン押下でトークンサーバーに `POST /token`（`{identity, room}`）を叩いてLiveKit接続情報を取得する。

| ロール表示名 | identity | 参加room |
|---|---|---|
| 参加者A | `participant-a` | room-a |
| 参加者B | `participant-b` | room-a |
| 参加者C | `participant-c` | room-b |
| 参加者D | `participant-d` | room-b |
| 同時参加者 | `subject-01` | room-a, room-b（両方） |

取得したセッション（`{token, url, room, identity, name?}` の配列）を `sessionStorage['livekit_session']` に保存し、
room数が1なら `/meeting`、2なら `/comma-debug` に遷移する。

### 3.3 `Meeting.tsx` — 通常の単一会議参加画面

`sessionStorage` からセッションを復元し、LiveKit公式の `VideoConference` コンポーネントで会議に参加する。
下部に `TranscriptPanel` を表示（複数room対応のレイアウトになっているが、現状Home経由では1room分しか渡らない）。

### 3.4 `TranscriptPanel.tsx`

LiveKitの `dataReceived` イベントを `topic==='transcript'` でフィルタして受信し、発話者名と本文を一覧表示。
最大100件保持。自動スクロールは「下端にいる間だけ追従し、上にスクロールしたら止まる。『最新へ戻る』ボタンで再追従」という挙動。

### 3.5 `CommaDebug.tsx` — 2会議並行参加のメイン画面

この画面が本システムの中核機能。構成要素は以下。

#### 全体のデータフロー

```
[room-a / room-b それぞれ]
  LiveKitRoom (hidden, video+audioはsubscribeのみ)
     └─ CommaTrackBridge  … サクラ最大2名分の camera/mic track を抽出
          └─ useCompositeMeetingStream … 2名分を1枚のcanvasに合成(320x240×2, 10fps) + 音声мix
               └─ useMeetingRecorder … 合成video+audioをMediaRecorderで継続録画(MediaSource/SourceBuffer, 〜60秒分バッファ)
                    └─ PlaybackController … room-a/room-bを10秒ごとに交互に「フォーカス」し、
                                              フォーカス中のroomを2倍速でバッファの少し手前から再生、
                                              非フォーカスroomは一時停止（静止画になる）

[呼びかけ検知]
  agent.py が Deepgram結果にキーワード一致 → LiveKitデータチャンネル topic="summon" を送信
     └─ useSummonSignal … summonedRoom状態を管理、lost window(見逃し区間)を記録
          └─ RealtimeOverlay … 呼ばれたroomのサクラ映像を生トラックでフルクオリティ・低遅延表示（倍速パネルの上に重畳）
          └─ 他方roomの倍速再生はそのまま継続（ユーザーは見ていないが再生は進む＝見逃しが発生）

[字幕]
  agent.py が Deepgram FINAL_TRANSCRIPT ごとに topic="transcript" を送信
     └─ useSubtitleSync … 各roomの字幕をリアルタイム表示（再生の2倍速/フォーカスとは完全に独立）
          └─ SubtitleColumn内で lost windowに重なる行をハイライト
```

#### 各要素の役割

**`CommaTrackBridge.tsx`**
- 1つのLiveKitRoom内で、ローカル以外の参加者（サクラ）のカメラ/マイクトラックを最大2名分 (`MAX_SAKURA_PER_ROOM = 2`) まで取得し、`onTracks`/`onRoom` コールバックで外部に渡す。
- 選ばれる2名の識別子（identity）は「固定（sticky）」で、一度選ばれた参加者は退出するまで入れ替わらない（`useTracks` がミュート/発話レベル変化などで頻繁に再計算されるため、素朴な再選定だと選ばれる参加者がちらつく問題への対策）。
- 各サクラの音声パブリケーションを非表示 `<audio muted>` 要素に `attach()` することで、Chromeのpull駆動なWebRTC音声デコードパイプラインを起動させている（video側は常時デコードされるが、audioはどこかで「消費」されないとデコードが始まらないため）。

**`useCompositeMeetingStream.ts`**
- 1room分、最大2名のサクラの映像を 320×240 のセルとして1枚の `<canvas>`（計640×240、10fps）に合成し、各セル左下に話者名ラベル（色付き、`speakerDisplay` 参照）を焼き込む。
- 音声は `AudioContext` + `MediaStreamAudioDestinationNode` でミックスして1本のaudio trackにまとめる。
- 出力される `videoTrack`/`audioTrack` はmeeting IDが変わらない限りオブジェクトIDが安定しており、サクラの入退室があってもダウンストリームの録画が再起動しない設計。

**`useMeetingRecorder.ts`**
- 渡された合成video(+audio) trackを単一の `MediaRecorder` で録画し、`MediaSource`/`SourceBuffer` に流し込んで `<video>` 要素から「録り溜めたバッファを後から再生できる」状態（簡易DVR）を作る。
- `timesliceMs=250ms` でチャンク化。バッファは既定60秒まで保持し、超えた古い範囲を定期的に `SourceBuffer.remove()` で削除（`requestEviction`、再生位置を侵さないよう安全マージン付き）。
- `recorder.onstart` 時刻（`recordingStartEpochMs`）を記録しており、これが「メディア内時刻 ⇔ 実時刻（epoch ms）」変換の基準点になる。
- video/audioは当初別々の `MediaRecorder` で試みたが、リモートaudio trackが「消費」されるまでデコードされない仕様のせいでハングする問題があり、`CommaTrackBridge` 側のaudio要素attach対策と合わせて単一recorderに統合した、という経緯がコード内コメントに記載。

**`useCommaScheduler.ts`**
- 10秒周期でA/Bのフォーカスを交互に切り替えるタイマー。`setTimeout` + `performance.now()` から絶対サイクル番号を都度再計算することで、タブが非アクティブになってタイマーが遅延してもズレが蓄積しない（遅延した分は「今あるべきサイクルへジャンプ」する）自己修正型。

**`PlaybackController.tsx`**
- A/B 2つの `<video>` 要素を保持し、`useCommaScheduler` のフォーカス切り替えに応じて:
  - フォーカスが外れる側: バッファ末尾に対して `CATCHUP_EPSILON_SEC=0.75秒` 以上遅れていたら、その場で再生位置をバッファ末尾まで強制的に進める（「追いつき処理」, `catchup-missed` イベント）。
  - 新たにフォーカスされる側: バッファが十分あれば `(バッファ末尾 - 10秒)` の位置にシークし、再生速度2.0倍で再生開始。バッファが空ならウォームアップとして1.0倍速で再生（`warmup-fallback` イベント）。
  - 非フォーカス側は `pause()`（最後のフレームが静止画として残る）。
- 5秒ごとにバッファの古い部分を破棄（`requestEviction`）。
- `ref` 経由の命令的ハンドル（`PlaybackControllerHandle`）で、現在時刻取得・フォーカス取得・ミュート制御・`unlockPlayback`（ブラウザの自動再生ポリシー対策、ユーザー操作直後に同期的に呼ぶ必要がある）・`getPlaybackEpochMs`（再生中メディア位置→実時刻変換。`recordingStartEpochMs + currentTime*1000` で算出）・`getLiveEdgeEpochMs`（バッファ最新端の実時刻）・`getSnapshot`（デバッグ用スナップショット）を公開。

**`useSummonSignal.ts`**
- LiveKitデータチャンネル `topic==="summon"` を受信、または画面上の「test : A呼びかけ」「test : B呼びかけ」ボタンから `trigger(room)` を呼ぶことで、呼びかけ応答状態（`summonedRoom`）を開始する。
- 応答中に二重に呼びかけが来た場合は無視（再入防止）。
- 「見逃し区間（lost window）」を2種類記録する:
  - **`realtime-jump`**（呼ばれた側のroom）: 呼びかけ発生時点でのバッファ再生位置から、実際にリアルタイム映像へ切り替わった瞬間（`RealtimeOverlay` の `onLive` コールバック、`markRealtimeReached`）までの区間。切り替えに `MAX_SWITCH_EXTENSION_MS=3秒` 以上かかった場合は異常とみなし延長しない。
  - **`unattended-playback`**（呼ばれていない側のroom）: 応答中もそのroomの倍速再生は止まらず進み続けるため、応答開始時点の再生位置から、`UNATTENDED_POLL_MS=500ms` ごとに現在の再生位置まで区間を延伸し続け、応答終了（`clear()`）で確定する。
  - いずれも `MIN_LOST_WINDOW_MS=500ms` 未満の区間は記録しない（すでにリアルタイムに追いついていた場合などノイズ扱い）。
- 応答継続時間そのものを記録する `responseWindows` も保持するが、これは研究ログ用であり字幕ハイライトには使わない（ハイライト判定は `lostWindows` のみを使う）。
- `overlapsLostWindow()`: 字幕の発話区間（`speechStartEpochMs`〜`speechEndEpochMs`）が1つでもlost windowと重なっていれば true。windowは履歴として保持され続けるため、後から届いた字幕やスクロールで過去に戻った場合も正しくハイライトされる（字幕作成時にハイライト済みフラグを焼き込む方式ではない）。

**`RealtimeOverlay.tsx`**
- 呼ばれた側のroomについて、`useCompositeMeetingStream` の低画質合成（240p/10fps）をバイパスし、サクラの生のカメラ/マイク `MediaStreamTrack` を直接 `<video>` にアタッチしてフル品質・低遅延のライブ映像を表示する。倍速再生パネルの上に重畳表示され、下の交互再生自体は止めずに動き続ける。
- 最初に実際に映像が再生開始した瞬間（`onPlaying`）に一度だけ `onLive` を呼び、`useSummonSignal` 側のlost window確定に使われる。

**`CommaDebug.tsx` 本体（画面構成）**
- 上部バー: 戻る / 同時参加者表示 / 「開始」ボタン（サクラ映像が両room揃うまで無効、押下時に同期的に `unlockPlayback()` を呼んでブラウザの自動再生制限を回避してから `started=true`）/ 中央に「応答終了」ボタン（応答中のみ有効、オレンジに点滅）/ 右側にテスト用の呼びかけボタン2つ / デバッグ情報の開閉ボタン。
- 非表示の `LiveKitRoom`×2（room-a, room-b）を常時マウントし、`CommaTrackBridge` でトラックを吸い上げる。
- 映像行: `PlaybackController` のA/Bパネル（アスペクト比16:3固定）の上に、`summonedRoom` に応じて該当側へ `RealtimeOverlay` を絶対位置で重畳。
- 応答中は両room（倍速再生中の `<video>`）をミュート（一時停止はしない。`controllerRef.setMuted`）し、ローカルマイクは呼ばれている側のroomにのみ `setMicrophoneEnabled(true)` で発行する（通常時はどちらにもマイクを発行しない＝同時参加者はデフォルトで「視聴のみ」）。
- 字幕行: `SubtitleColumn`（room-a/room-b別）。最新へ自動スクロールし、ユーザーが上にスクロールすると追従を止めて「最新へ戻る↓」ボタンを出す（`TranscriptPanel`と同じパターン）。lost windowに重なる行はオレンジ背景＋左ボーダーでハイライト。
- デバッグ情報（`DebugReadout`）: 開閉式のオーバーレイで、`PlaybackController` のスナップショットを200msごとにポーリングして、フォーカス/サイクル番号/各roomの再生状態・バッファ範囲・「実時刻からの遅れ秒数」・直近の `focus-switch`/`catchup-missed`/`warmup-fallback` イベントログ・lost window一覧を表示する。

### 3.6 `lib/`

- **`codec.ts`**: `MediaRecorder`/`MediaSource` 両方が対応するmimeTypeを探索（`video/webm;codecs=vp9,opus` → `vp8,opus` → `webm` の順、音声なし版も用意）。
- **`sourceBufferQueue.ts`**: `SourceBuffer.appendBuffer`/`remove` は非同期かつ排他（`updating`フラグ）のため、両操作を1本のFIFOキューで直列化するユーティリティ。
- **`speakerDisplay.ts`**: identity→表示名/色の対応表（`participant-a`=Aさん(赤)、`b`=Bさん(青)、`c`=Cさん(緑)、`d`=Dさん(黄)、それ以外は「あなた」(白)）。合成映像のラベルと字幕の色分けで共有して使用。

### 3.7 `SpikeTest.tsx`

本番機能とは独立した検証用ページ。単一トラックを `MediaRecorder`→`MediaSource`→`<video>` のパイプラインに流すだけの最小実装で、録画バッファ/コマ送り/字幕同期など一切のロジックを持たない。ブラウザ環境でMSEパイプライン自体が動くかどうかを切り離して確認するためのもの。

---

## 4. バックエンド（Agent, Python / LiveKit Agents SDK）

### 4.1 `agent.py`

- 1プロセス = 1room想定（`PMS_AGENT_IDENTITY` 環境変数でworker名を指定。例: `pms-agent-room-a`）。
- ルーム接続後、既存参加者と新規参加者それぞれについて `log_participant()` で identity/name/metadata/参加時刻を標準出力にログ。
- `DeepgramTranscriptPrinter` クラスが、roomに参加する各リモート参加者の**マイク（音声）トラック**ごとに非同期タスクを起動し、Deepgram STT（`nova-3`, `language="ja"`, `interim_results=False`）にストリーミングして文字起こしする。トラックのsubscribe/unsubscribe・参加者退出に応じてタスクを動的に開始/キャンセルする。
- **`AudioClock`**: Deepgramが返す「ストリーム相対秒」を実時刻（epoch ms）に変換するための仕組み。固定アンカー（ストリーム開始時刻＋相対秒）ではなく、音声フレームを投入する度に「これまでに投入した音声の累積長」と「その瞬間の壁時計」を更新し続ける方式。ミュートやパケットロスで音声が途切れても、ズレが蓄積せず再開後に自動補正される（コード中に詳細な設計理由のコメントあり）。
- **`_speech_epoch_range_ms()`**: Deepgramの `SpeechData` から実際の発話開始/終了をepoch msで算出。`livekit-plugins-deepgram` の既知の不具合（`end_time` が実際には「最初の単語」のendを指してしまう）を踏まえ、`words[-1].end_time` を自前で優先的に使用。タイムスタンプが一切取れない場合はfinal確定時刻を1点区間として代用（`fallback-finalized`）。ストリーム再接続などでクロックが現実離れした値を返した場合は発話長のみを信用して確定時刻から逆算するフォールバック（`clock-resync`、`MAX_SPEECH_LAG_MS=15秒`を閾値）も実装。
- FINAL_TRANSCRIPTごとに:
  - LiveKitデータチャンネル `topic="transcript"` に `{room, participant, text, timestamp, finalized_at, speech_start_ms, speech_end_ms, speech_time_source}` をJSONでpublish（`reliable=True`）。
  - テキストが `PMS_SUMMON_KEYWORDS`（既定 `"田中"`、カンマ区切りで複数設定可）のいずれかを含む場合、追加で `topic="summon"` に `{participant, text, timestamp, speech_start_ms, speech_end_ms, speech_time_source}` をpublish。
- LLMは使用せず、単純な部分文字列マッチで呼びかけ検知している（`docs/configuration.md` の設計方針どおり）。

### 4.2 `agent_dispatch.py`

- LiveKit Server API（`livekit.api`）を使い、`room-a`→`pms-agent-room-a`、`room-b`→`pms-agent-room-b` の対応で明示的にAgent dispatchを作成するCLIツール。
- 引数なしなら両room、引数で特定のroom名を指定すればそのroomのみにdispatch。
- README記載の運用上の用途: LiveKit Cloud側の自動dispatchでAgentが入ってこない場合の手動トリガー。

---

## 5. LiveKitデータチャンネルのプロトコル（agent↔frontend間）

| topic | 送信元 | 内容 | 用途 |
|---|---|---|---|
| `transcript` | agent.py | `{room, participant, text, timestamp, finalized_at, speech_start_ms, speech_end_ms, speech_time_source}` | `TranscriptPanel`（Meeting画面）・`useSubtitleSync`（CommaDebug画面）が表示に使用 |
| `summon` | agent.py | `{participant, text, timestamp, speech_start_ms, speech_end_ms, speech_time_source}` | `useSummonSignal` が呼びかけ検知として受信しリアルタイム応答モードに切り替える |

---

## 6. 起動方法（`README.md` より）

```bash
# フロントエンド
cd frontend && npm run dev

# Agent（room-a用、別ターミナル）
cd agent
.venv\Scripts\activate
set PMS_AGENT_IDENTITY=pms-agent-room-a
python agent.py dev

# Agent（room-b用、別ターミナル）
cd agent
.venv\Scripts\activate
set PMS_AGENT_IDENTITY=pms-agent-room-b
python agent.py dev
```

Agentが自動でroomに参加しない場合は `python agent_dispatch.py` で明示的にdispatchする。
トークンサーバーのヘルスチェック: `https://pms-token-server.onrender.com/health`。

---

## 7. このドキュメントの対象外（未確認）

- トークンサーバー（`pms-token-server`）自体の実装は別リポジトリであり本調査の対象外。
- 実験プロトコル・測定項目・評価指標（研究計画そのもの）は本リポジトリのコードからは確認できないため記載していない。
