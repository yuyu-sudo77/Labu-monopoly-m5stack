# M5Stack 搖動擲骰：學生整合任務

遊戲網頁端已有 Web Serial 接收功能，並提供 M5StickC Plus 韌體範例。韌體尚未在實際硬體上驗證，閾值仍需依裝置與使用方式調整。

## 目標與流程

1. 確認實際 M5Stack 型號是否內建 IMU，或需外接加速度感測器；安裝對應開發環境與函式庫。
2. 定期讀取三軸加速度，偵測明顯的搖動。設定閾值、消除重複觸發，靜止後才允許下一次搖動；閾值與時間應以實機調校。
3. 裝置透過選定的連線方式傳出「搖動」事件，由使用者操作的遊戲客戶端轉成擲骰請求。
4. 只有自己的回合、處於可擲骰狀態且連線正常時才送出一次 `roll`；其他狀態顯示原因。骰子數仍由交通工具決定，點數由遊戲規則產生。
5. 斷線時保留原有按鈕；重新連線後不重送舊搖動事件。

## 建議開發順序

- **第一階段：感測器**：先在序列埠顯示加速度並確認實際型號與座標、單位；例如支援 M5Unified 的機種可參考[官方 IMU 文件](https://docs.m5stack.com/en/arduino/m5unified/imu_class)與 `M5.Imu.getImuData()`。不同型號的 API 與 IMU 可能不同。
- **第二階段：傳輸**：先選擇實驗環境。電腦端可評估 USB Web Serial 或 BLE Web Bluetooth，兩者均受瀏覽器與 HTTPS/localhost 限制；手機尤其需要先確認支援狀況。也可設計同網路的配對中介服務，但需要自行實作身分驗證與安全傳輸。參考 [Web Serial](https://developer.mozilla.org/en-US/docs/Web/API/Web_Serial_API)、[Web Bluetooth](https://developer.mozilla.org/en-US/docs/Web/API/Web_Bluetooth_API)。
- **第三階段：串接遊戲**：先找 `src/main.ts` 的 `canAct()`、`act()`、`#turn-action` 與 `src/engine.ts` 的 `roll` 動作。讓硬體觸發共用同一合法擲骰流程，勿用裝置直接決定或覆寫骰點，也不要讓搖動在抵達後誤觸「結束回合」。
- **第四階段：多人驗證**：多人走 `src/network.ts` 的 `RoomClient.command()`，房間服務驗證玩家身分、回合與狀態；多人骰點由伺服器規則決定。裝置應配對到正確玩家，而非讓所有玩家的裝置都能操作同一個席位。

## 驗收清單

- 一次有效搖動只擲一次；持續晃動、背景噪聲與斷線重連不重複觸發。
- 非本人回合、移動動畫中、等待選項或遊戲結束時不擲骰，也不自動結束回合。
- 步行、機車／腳踏車、汽車分別使用遊戲既有的骰子數；多人狀態在所有玩家畫面一致。
- 裝置斷線仍可使用螢幕按鈕；重新配對後可繼續遊玩。
- 測試至少包含感測器閾值與去彈跳、回合權限、重複訊息、離線及多人流程，再用實際 M5Stack、目標手機及瀏覽器驗證。

不要把房間憑證、Wi-Fi 密碼或 API 金鑰寫入公開程式碼。若未來使用網路中介，應加入裝置配對、驗證、加密與速率限制；在教學環境先以本機或隔離網路驗證。

## 目前瀏覽器實作

遊戲已提供 Web Serial 配對入口：開啟「遊戲設定」，按下「配對 M5Stack」，選擇對應序列埠並設定 115200 baud。此配對需要使用者操作、瀏覽器支援 Web Serial 且頁面在 HTTPS 或 localhost。

裝置偵測有效搖動後，每次只需傳出一行 `SHAKE` 或 JSON `{"type":"shake"}`。網頁端負責去彈跳（預設冷卻 1.2 秒），並以遊戲 seed、回合編號及玩家 ID 記錄每回合已使用的搖動擲骰；同一回合即使重複收到搖動也不會再次呼叫 `roll`。只有以下條件成立時才呼叫既有的 `{ type: "roll" }` 流程：

- 遊戲已開始且未暫停；
- 目前為自由擲骰階段 `state.phase === "roll"`；
- 非移動中、非等待選項、非遊戲結束；
- 本機模式輪到真人玩家；
- 多人模式房間已連線、目前玩家是自己且沒有待接回。

搖動永遠不會送出 `finishTurn`。斷線或重新配對只會清除目前序列連線，不會重播舊事件；螢幕上的擲骰按鈕不受影響。多人擲骰仍由 `RoomClient.command()` 與伺服器驗證，裝置不會決定或覆寫骰點。

## M5StickC Plus 韌體

Arduino 範例位於 `firmware/m5stickc-plus/m5stickc-plus.ino`，使用 M5Unified 讀取內建 IMU，序列埠速率為 115200 baud。安裝 Espressif ESP32 Arduino 開發板套件及 M5Unified 函式庫後，依 M5Stack 官方 Arduino IDE 指引選擇 StickC Plus 對應板型，開啟並燒錄此 sketch。燒錄時使用 USB 資料線；網頁連線時請關閉 Arduino 序列監控視窗。

範例每 20 ms 讀取一次加速度，需在 3 秒內偵測到至少三次明顯加速度變化（每次至少 0.45 g）才送出一行 `SHAKE`，降低單次拿起或移動造成誤觸的機率。連續搖動後需靜止 700 ms 才重新啟用；單回合防重複由網頁回合鎖處理。序列埠每 200 ms 輸出 `IMU,ax,ay,az,delta,pulses,events` 診斷資料；網頁重新配對時會傳送 `RESET`，將裝置及網頁顯示的事件計數歸零。裝置螢幕與遊戲設定頁會顯示感測器讀值、脈衝數及已送出事件計數。送出事件後，裝置顯示提示 3 秒。仍需依實際握持與搖動方式測試；若仍不易觸發，可調整門檻或時間。

參考：[M5StickC Plus 官方規格與 Arduino IDE 指引](https://docs.m5stack.com/en/core/StickC-Plus)、[M5Unified IMU API](https://docs.m5stack.com/en/arduino/m5unified/imu_class)。
