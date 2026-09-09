/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

// The approved notification chime (prototype variant 15): a soft two-note sine
// D5 -> A5 via WebAudio, no asset files. Lazily creates one AudioContext and
// resumes it — browsers block audio until a user gesture, so the first chime
// only sounds once the admin has interacted with the page.
let audioContext: AudioContext | null = null

export function playNotificationChime(): void {
  if (typeof window === 'undefined') {
    return
  }
  try {
    const AudioCtor =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext
    if (!AudioCtor) {
      return
    }
    if (!audioContext) {
      audioContext = new AudioCtor()
    }
    if (audioContext.state === 'suspended') {
      void audioContext.resume()
    }
    const ctx = audioContext
    const t0 = ctx.currentTime
    const master = ctx.createGain()
    master.gain.value = 0.0001
    master.connect(ctx.destination)
    master.gain.setValueAtTime(0.0001, t0)
    master.gain.exponentialRampToValueAtTime(0.16, t0 + 0.02)
    master.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.55)
    ;[587.33, 880].forEach((frequency, i) => {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.value = frequency
      gain.gain.value = i === 0 ? 1 : 0.7
      osc.connect(gain)
      gain.connect(master)
      osc.start(t0 + i * 0.08)
      osc.stop(t0 + 0.6)
    })
  } catch {
    // Audio unavailable (autoplay policy, no device) — silently skip.
  }
}
