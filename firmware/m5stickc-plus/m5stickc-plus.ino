#include <M5Unified.h>
#include <cstring>

namespace {
constexpr float kShakeDeltaThresholdG = 0.45f;
constexpr float kQuietDeltaThresholdG = 0.16f;
constexpr float kPulseReleaseDeltaThresholdG = 0.22f;
constexpr uint32_t kQuietRearmMs = 700;
constexpr uint32_t kShakePatternWindowMs = 3000;
constexpr uint32_t kSampleIntervalMs = 20;
constexpr uint32_t kDisplayIntervalMs = 150;
constexpr uint32_t kTelemetryIntervalMs = 200;
constexpr uint8_t kRequiredShakePulses = 3;

float previousX = 0.0f;
float previousY = 0.0f;
float previousZ = 0.0f;
bool hasPreviousSample = false;
bool shakeLatched = false;
bool pulseActive = false;
uint32_t quietSince = 0;
uint32_t lastSampleAt = 0;
uint32_t lastDisplayAt = 0;
uint32_t lastTelemetryAt = 0;
uint32_t lastPulseAt = 0;
uint32_t showShakeUntil = 0;
uint32_t eventsSent = 0;
float lastDelta = 0.0f;
uint8_t shakePulses = 0;
char serialCommand[16];
size_t serialCommandLength = 0;

void drawStatus(bool imuReady) {
  M5.Display.fillScreen(TFT_BLACK);
  M5.Display.setTextColor(TFT_WHITE, TFT_BLACK);
  M5.Display.setTextSize(2);
  M5.Display.setCursor(4, 4);
  M5.Display.println("M5 Dice");
  M5.Display.setTextSize(1);
  M5.Display.setCursor(4, 34);
  M5.Display.printf("IMU: %s", imuReady ? "READY" : "ERROR");
  M5.Display.setCursor(4, 54);
  M5.Display.printf("Motion: %.2f / %.2f g", lastDelta, kShakeDeltaThresholdG);
  M5.Display.setCursor(4, 76);
  M5.Display.printf("Pulses: %u / %u", shakePulses, kRequiredShakePulses);
  M5.Display.setCursor(4, 96);
  M5.Display.println(millis() < showShakeUntil ? "SHAKE SENT!" : "Shake firmly");
  M5.Display.setCursor(4, 116);
  M5.Display.printf("Events: %lu", static_cast<unsigned long>(eventsSent));
}

void processSerialCommands() {
  while (Serial.available() > 0) {
    const char value = static_cast<char>(Serial.read());
    if (value == '\r') continue;
    if (value == '\n') {
      serialCommand[serialCommandLength] = '\0';
      if (strcmp(serialCommand, "RESET") == 0) {
        eventsSent = 0;
        shakePulses = 0;
        pulseActive = false;
        shakeLatched = false;
        quietSince = 0;
        showShakeUntil = 0;
        Serial.println("RESET_OK");
        drawStatus(M5.Imu.isEnabled());
      }
      serialCommandLength = 0;
    } else if (serialCommandLength < sizeof(serialCommand) - 1) {
      serialCommand[serialCommandLength++] = value;
    } else {
      serialCommandLength = 0;
    }
  }
}
}

void setup() {
  auto config = M5.config();
  M5.begin(config);
  Serial.begin(115200);
  M5.Display.setRotation(1);
  M5.Display.setBrightness(128);

  if (!M5.Imu.isEnabled()) {
    Serial.println("IMU_NOT_AVAILABLE");
    drawStatus(false);
    while (true) delay(1000);
  }

  drawStatus(true);
  Serial.println("M5StickCPlus_READY");
}

void loop() {
  M5.update();
  processSerialCommands();
  const uint32_t now = millis();
  if (now - lastSampleAt < kSampleIntervalMs) return;
  lastSampleAt = now;

  float x, y, z;
  if (!M5.Imu.getAccel(&x, &y, &z)) return;
  if (!hasPreviousSample) {
    previousX = x;
    previousY = y;
    previousZ = z;
    hasPreviousSample = true;
    return;
  }

  const float dx = x - previousX;
  const float dy = y - previousY;
  const float dz = z - previousZ;
  const float delta = sqrtf(dx * dx + dy * dy + dz * dz);
  lastDelta = delta;
  previousX = x;
  previousY = y;
  previousZ = z;

  if (now - lastTelemetryAt >= kTelemetryIntervalMs) {
    lastTelemetryAt = now;
    Serial.printf("IMU,%.3f,%.3f,%.3f,%.3f,%u,%lu\n", x, y, z, delta, shakePulses, static_cast<unsigned long>(eventsSent));
  }

  if (now - lastDisplayAt >= kDisplayIntervalMs) {
    lastDisplayAt = now;
    drawStatus(M5.Imu.isEnabled());
  }

  if (shakeLatched) {
    if (delta < kQuietDeltaThresholdG) {
      if (quietSince == 0) quietSince = now;
      if (now - quietSince >= kQuietRearmMs) {
        shakeLatched = false;
        quietSince = 0;
        pulseActive = false;
        shakePulses = 0;
      }
    } else {
      quietSince = 0;
    }
    return;
  }

  if (shakePulses > 0 && now - lastPulseAt > kShakePatternWindowMs) {
    shakePulses = 0;
  }
  if (delta < kPulseReleaseDeltaThresholdG) pulseActive = false;
  if (delta < kShakeDeltaThresholdG || pulseActive) return;

  pulseActive = true;
  const bool patternExpired = shakePulses == 0 || now - lastPulseAt > kShakePatternWindowMs;
  shakePulses = patternExpired ? 1 : shakePulses + 1;
  lastPulseAt = now;

  if (shakePulses >= kRequiredShakePulses) {
    eventsSent++;
    Serial.println("SHAKE");
    shakeLatched = true;
    quietSince = 0;
    showShakeUntil = now + 3000;
    drawStatus(true);
  }
}
