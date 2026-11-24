-- Reuse account-scoped word/example storage from the desktop schema.
GRANT SELECT, INSERT, UPDATE, DELETE ON wordpaper.user_word_examples TO wordpaper_runtime;
