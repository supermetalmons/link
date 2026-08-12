import React from "react";
import styled, { keyframes } from "styled-components";
import {
  getRainbowAuraGradient,
  getRainbowAuraMaskUrl,
  RAINBOW_AURA_SCALE,
  RAINBOW_AURA_OFFSET_PERCENT,
  RAINBOW_AURA_BLUR_PX,
  RAINBOW_AURA_OPACITY,
  RAINBOW_MASK_CSS_BASE,
  RAINBOW_AURA_ROTATION_S,
  RAINBOW_AURA_ROTATOR_SIZE_PERCENT,
} from "./rainbowAura";

const rotate = keyframes`
  to { transform: rotate(360deg); }
`;

const AvatarContainer = styled.div`
  position: relative;
  width: 100%;
  height: 100%;
  border-radius: 2px;
`;

const RainbowBackground = styled.div`
  position: absolute;
  z-index: 1;
  width: ${RAINBOW_AURA_SCALE * 100}%;
  height: ${RAINBOW_AURA_SCALE * 100}%;
  top: ${RAINBOW_AURA_OFFSET_PERCENT}%;
  left: ${RAINBOW_AURA_OFFSET_PERCENT}%;
  filter: blur(${RAINBOW_AURA_BLUR_PX}px);
  opacity: ${RAINBOW_AURA_OPACITY};
`;

const RainbowInner = styled.div<{ $src: string }>`
  position: absolute;
  inset: 0;
  ${RAINBOW_MASK_CSS_BASE}
  -webkit-mask-image: url(${({ $src }) => getRainbowAuraMaskUrl($src)});
  mask-image: url(${({ $src }) => getRainbowAuraMaskUrl($src)});
`;

const RainbowRotatorWrap = styled.div`
  position: absolute;
  top: 50%;
  left: 50%;
  width: ${RAINBOW_AURA_ROTATOR_SIZE_PERCENT}%;
  height: ${RAINBOW_AURA_ROTATOR_SIZE_PERCENT}%;
  transform: translate(-50%, -50%);
  pointer-events: none;
  overflow: visible;
`;

const RainbowRotator = styled.div`
  position: absolute;
  inset: 0;
  background: ${getRainbowAuraGradient()};
  will-change: transform;
  transform-origin: 50% 50%;
  animation: ${rotate} ${RAINBOW_AURA_ROTATION_S}s linear infinite;
  @media (prefers-reduced-motion: reduce) {
    animation: none !important;
  }
`;

const StyledAvatarImage = styled.img`
  position: relative;
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
  border-radius: 2px;
  pointer-events: none;
  -webkit-user-drag: none;
  user-drag: none;
  z-index: 2;
`;

interface AvatarImageProps {
  src: string;
  alt: string;
  rainbowAura?: boolean;
  loading?: "lazy" | "eager";
  onLoad?: () => void;
}

export const AvatarImage: React.FC<AvatarImageProps> = ({
  src,
  alt,
  rainbowAura = false,
  loading = "lazy",
  onLoad,
}) => {
  return (
    <AvatarContainer>
      {rainbowAura && (
        <RainbowBackground>
          <RainbowInner $src={src}>
            <RainbowRotatorWrap>
              <RainbowRotator />
            </RainbowRotatorWrap>
          </RainbowInner>
        </RainbowBackground>
      )}
      <StyledAvatarImage
        src={src}
        alt={alt}
        loading={loading}
        onLoad={onLoad}
      />
    </AvatarContainer>
  );
};
