import styled from "styled-components";

export const ToggleRow = styled.label`
  display: flex;
  align-items: center;
  gap: 8px;
  align-self: center;
  font-size: 14px;
  color: var(--color-gray-33);

  @media (prefers-color-scheme: dark) {
    color: var(--color-gray-f5);
  }
`;

export const TelegramAnnouncements = styled.fieldset`
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  margin: 0;
  padding: 0;
  border: none;
  color: var(--color-gray-33);

  legend {
    padding: 0;
    margin-bottom: 8px;
    font-size: 14px;
    font-weight: 600;
  }

  @media (prefers-color-scheme: dark) {
    color: var(--color-gray-f5);
  }
`;

export const TelegramAnnouncementToggle = styled(ToggleRow)`
  align-self: stretch;
  line-height: 1.35;
  cursor: pointer;

  input {
    flex-shrink: 0;
    margin: 0;
  }
`;

export const TelegramAnnouncementsHint = styled.p`
  margin: 0;
  font-size: 12px;
  line-height: 1.4;
`;

export const ScheduleModeToggle = styled.div`
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
`;

export const ScheduleModeButton = styled.button<{ $active: boolean }>`
  height: 34px;
  border: none;
  border-radius: 999px;
  padding: 0 10px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  color: ${(props) => (props.$active ? "white" : "var(--color-gray-33)")};
  background: ${(props) =>
    props.$active ? "var(--color-blue-primary)" : "rgba(111, 126, 141, 0.2)"};

  @media (prefers-color-scheme: dark) {
    color: ${(props) => (props.$active ? "white" : "var(--color-gray-f5)")};
    background: ${(props) =>
      props.$active
        ? "var(--color-blue-primary-dark)"
        : "rgba(255, 255, 255, 0.12)"};
  }
`;

export const ExperimentalInput = styled.input`
  width: 100%;
  box-sizing: border-box;
  border: none;
  border-radius: 12px;
  padding: 10px 12px;
  font-size: 14px;
  background: rgba(111, 126, 141, 0.12);
  color: var(--color-gray-25);

  @media (prefers-color-scheme: dark) {
    background: rgba(255, 255, 255, 0.08);
    color: var(--color-gray-f5);
  }
`;

export const ExperimentalSelect = styled.select`
  width: 100%;
  box-sizing: border-box;
  border: none;
  border-radius: 12px;
  padding: 10px 12px;
  font-size: 14px;
  background: rgba(111, 126, 141, 0.12);
  color: var(--color-gray-25);

  @media (prefers-color-scheme: dark) {
    background: rgba(255, 255, 255, 0.08);
    color: var(--color-gray-f5);
  }
`;

export const ExperimentalActionButton = styled.button`
  height: 40px;
  border: none;
  border-radius: 999px;
  padding: 0 14px;
  margin-bottom: 24px;
  font-size: 14px;
  font-weight: 700;
  cursor: pointer;
  background: var(--color-blue-primary);
  color: white;

  &:disabled {
    opacity: 0.6;
    cursor: default;
  }

  @media (prefers-color-scheme: dark) {
    background: var(--color-blue-primary-dark);
  }
`;

export const ExperimentalInlineError = styled.div`
  font-size: 12px;
  line-height: 1.35;
  color: var(--dangerButtonBackground);
  text-align: center;

  @media (prefers-color-scheme: dark) {
    color: var(--dangerButtonBackgroundDark);
  }
`;
