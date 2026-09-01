"use client";

import { useState, type FormEvent } from "react";
import type { SessionState } from "./types";
import styles from "./lesson.module.css";

export interface ComposerProps {
  status: SessionState;
  micEnabled: boolean;
  micAvailable: boolean;
  onToggleMic: () => void;
  onInterrupt: () => void;
  onSendText: (text: string) => void;
}

/**
 * Voice-only lesson controls. Learner input is microphone audio; the tutor
 * responds with synchronized audio, transcript, cards, and generated video.
 */
export function Composer({
  status,
  micEnabled,
  micAvailable,
  onToggleMic,
  onInterrupt,
  onSendText,
}: ComposerProps) {
  const [text, setText] = useState("");
  const ended = status === "ended";
  const connecting = status === "connecting" || status === "reconnecting";
  const speaking = status === "speaking" || status === "thinking" || status === "redirecting";
  const unavailable = status === "text_only" || !micAvailable;
  const voiceStatus = connecting
    ? "Connecting…"
    : unavailable
      ? "Voice connection unavailable"
      : speaking
        ? "Generating…"
        : micEnabled
          ? "Listening"
          : "Paused";
  const submitText = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const message = text.trim();
    if (!message) return;
    onSendText(message);
    setText("");
  };

  return (
    <footer className={styles.composerCol}>
      <form className={styles.composer} onSubmit={submitText}>
        <button
          type="button"
          className={styles.micButton}
          aria-pressed={micEnabled}
          aria-label={micEnabled ? "Mute microphone" : "Enable microphone"}
          title={unavailable ? "Microphone connection unavailable" : undefined}
          disabled={ended || connecting || unavailable}
          onClick={onToggleMic}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <rect x="9" y="3" width="6" height="11" rx="3" />
            <path d="M5 11a7 7 0 0 0 14 0" />
            <line x1="12" y1="18" x2="12" y2="21" />
            {!micEnabled && <line x1="4" y1="4" x2="20" y2="20" />}
          </svg>
        </button>
        {unavailable ? (
          <input
            className={styles.textInput}
            aria-label="Tell the story what happens next"
            placeholder="What should Niko and Moss do?"
            value={text}
            disabled={ended || connecting}
            onChange={(event) => setText(event.target.value)}
          />
        ) : (
          <>
            <div className={styles.waveform} aria-hidden="true" />
            <p className={styles.input} role="status" aria-live="polite">
              {voiceStatus}
            </p>
          </>
        )}
        {speaking && (
          <button type="button" className={styles.sendButton} onClick={onInterrupt}>
            Interrupt
          </button>
        )}
        {unavailable && (
          <button type="submit" className={styles.sendButton} disabled={!text.trim()}>
            Send
          </button>
        )}
      </form>
      <span className="sr-only">
        {unavailable
          ? "Voice is unavailable, so you can steer the story by typing."
          : "Speak naturally. You can interrupt the storyteller at any time."}
      </span>
    </footer>
  );
}
