UPDATE telegram_runtime_control
SET storage_mode = 'frozen', updated_at_ms = MAX(updated_at_ms, 1)
WHERE singleton = 1 AND storage_mode = 'firebase';

CREATE TRIGGER telegram_runtime_reject_firebase_insert
BEFORE INSERT ON telegram_runtime_control
WHEN NEW.storage_mode = 'firebase'
BEGIN
  SELECT RAISE(ABORT, 'firebase Telegram storage is retired');
END;

CREATE TRIGGER telegram_runtime_reject_firebase_update
BEFORE UPDATE OF storage_mode ON telegram_runtime_control
WHEN NEW.storage_mode = 'firebase'
BEGIN
  SELECT RAISE(ABORT, 'firebase Telegram storage is retired');
END;
