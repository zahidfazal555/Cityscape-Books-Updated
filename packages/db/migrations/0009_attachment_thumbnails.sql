-- 0009_attachment_thumbnails: a small JPEG per photo for list and approval cards (BUG-110).
-- Loading those cards reads the thumbnail, never the full photo, so the H4 audit trail records
-- only photos someone actually opened.
ALTER TABLE attachment ADD COLUMN thumbnail_key text UNIQUE;
