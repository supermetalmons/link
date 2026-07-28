import React, { useState, useEffect } from "react";
import { ControlButton } from "./BottomControlsStyles";

interface HourglassConfig {
  duration: number;
  progress: number;
  requestDate: number;
}

interface AnimatedHourglassIconProps {
  config: HourglassConfig;
}

const AnimatedHourglassIcon: React.FC<AnimatedHourglassIconProps> = ({
  config,
}) => {
  const { duration, progress, requestDate } = config;
  const [elapsedTime, setElapsedTime] = useState<number>(progress);

  useEffect(() => {
    let animationFrameId: number;
    const startTime = Date.now();

    const updateElapsedTime = () => {
      const currentTime = Date.now();
      const timeElapsed = progress + (currentTime - startTime) / 1000;
      const clampedTime = Math.min(timeElapsed, duration);
      setElapsedTime(clampedTime);

      if (clampedTime < duration) {
        animationFrameId = requestAnimationFrame(updateElapsedTime);
      }
    };

    updateElapsedTime();

    return () => {
      cancelAnimationFrame(animationFrameId);
    };
  }, [duration, progress, requestDate]);

  const progressRatio = elapsedTime / duration;

  const topSandHeight = 24 * (1 - progressRatio);
  const topSandY = 8 + 24 * progressRatio;

  const bottomSandHeight = 24 * progressRatio;
  const bottomSandY = 56 - bottomSandHeight;

  return (
    <svg
      width="64"
      height="64"
      viewBox="0 0 64 64"
      style={{ display: "block" }}
    >
      <path
        d="
          M16,8 H48
          M16,56 H48
          M16,8 L16,20 L32,32 L16,44 L16,56
          M48,8 L48,20 L32,32 L48,44 L48,56
        "
        stroke="currentColor"
        strokeWidth="4"
        fill="none"
      />

      <path
        d="M16,8 L48,8 L32,32 Z"
        fill="currentColor"
        clipPath="url(#top-sand-clip)"
      />
      <clipPath id="top-sand-clip">
        <rect x="0" y={topSandY} width="64" height={topSandHeight} />
      </clipPath>

      <path
        d="M16,56 L48,56 L32,32 Z"
        fill="currentColor"
        clipPath="url(#bottom-sand-clip)"
      />
      <clipPath id="bottom-sand-clip">
        <rect x="0" y={bottomSandY} width="64" height={bottomSandHeight} />
      </clipPath>
    </svg>
  );
};

interface AnimatedHourglassButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  config: HourglassConfig;
}

const AnimatedHourglassButton = React.forwardRef<
  HTMLButtonElement,
  AnimatedHourglassButtonProps
>(({ config, onClick, ...props }, ref) => {
  return (
    <ControlButton ref={ref} onClick={onClick} aria-label="Timer" {...props}>
      <AnimatedHourglassIcon config={config} />
    </ControlButton>
  );
});

AnimatedHourglassButton.displayName = "AnimatedHourglassButton";

export default AnimatedHourglassButton;
