import type { RefCallback } from "react";
import type { VisualState } from "./types";
import styles from "./lesson.module.css";

/** Generated video is the only moving lesson visual. */
export interface ScienceCanvasProps {
  visual: VisualState | null;
  videoReady?: boolean;
  /** Director-owned attach point bound to the generated stream. */
  videoRef?: RefCallback<HTMLVideoElement>;
}

function OpeningMessage({ overlay = false }: { overlay?: boolean }) {
  return (
    <div className={styles.canvasOpening} data-overlay={overlay || undefined}>
      <span className={styles.canvasOpeningRule} aria-hidden="true" />
      <p className={styles.canvasOpeningMessage}>Say where Niko and Moss should go first</p>
    </div>
  );
}

export function ScienceCanvas({
  visual,
  videoRef,
  videoReady = false,
}: ScienceCanvasProps) {
  if (!visual || !videoRef) {
    return (
      <figure className={styles.canvasFrame} aria-label="Interactive story canvas">
        <OpeningMessage />
      </figure>
    );
  }

  const held = visual.phase === "held";

  return (
    <figure
      className={styles.canvasFrame}
      aria-label={
        videoReady
          ? `Lesson visual: ${visual.spec.concept}. ${visual.spec.teachingIntent}`
          : "Interactive story canvas"
      }
    >
      <video
        className={styles.canvasScene}
        autoPlay
        crossOrigin="anonymous"
        data-ready={videoReady}
        muted
        playsInline
        ref={videoRef}
      />

      {!videoReady && <OpeningMessage overlay />}

      {videoReady && !held && (
        <span className={styles.canvasBadge} data-tone="live">
          Story world · live
        </span>
      )}
      {videoReady && held && (
        <span className={styles.canvasBadge}>Story world · waiting for your choice</span>
      )}

      {videoReady && (
        <figcaption className={styles.canvasCaption}>
          <p className={styles.canvasConcept}>{visual.spec.concept}</p>
          <p className={styles.canvasIntent}>{visual.spec.teachingIntent}</p>
        </figcaption>
      )}
    </figure>
  );
}
