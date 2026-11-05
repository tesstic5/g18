-- Admin-managed FAQ categories + articles (en/ur). Categories are first-class
-- so operators can add / rename / hide / delete them without a code deploy.

CREATE TABLE IF NOT EXISTS "FaqCategory" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "nameEn" TEXT NOT NULL,
    "nameUr" TEXT NOT NULL DEFAULT '',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FaqCategory_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "FaqCategory_slug_key" ON "FaqCategory"("slug");
CREATE INDEX IF NOT EXISTS "FaqCategory_isActive_sortOrder_idx"
  ON "FaqCategory"("isActive", "sortOrder");

CREATE TABLE IF NOT EXISTS "Faq" (
    "id" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "questionEn" TEXT NOT NULL,
    "questionUr" TEXT NOT NULL DEFAULT '',
    "answerEn" TEXT NOT NULL,
    "answerUr" TEXT NOT NULL DEFAULT '',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isPublished" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Faq_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "Faq_categoryId_isPublished_sortOrder_idx"
  ON "Faq"("categoryId", "isPublished", "sortOrder");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'Faq_categoryId_fkey'
  ) THEN
    ALTER TABLE "Faq"
      ADD CONSTRAINT "Faq_categoryId_fkey"
      FOREIGN KEY ("categoryId") REFERENCES "FaqCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
