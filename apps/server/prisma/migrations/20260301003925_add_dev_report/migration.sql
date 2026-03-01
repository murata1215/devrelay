-- CreateTable
CREATE TABLE "DevReport" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "projectName" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'generating',
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DevReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DevReportEntry" (
    "id" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "section" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DevReportEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DevReport_userId_idx" ON "DevReport"("userId");

-- CreateIndex
CREATE INDEX "DevReport_projectName_idx" ON "DevReport"("projectName");

-- CreateIndex
CREATE INDEX "DevReportEntry_messageId_idx" ON "DevReportEntry"("messageId");

-- CreateIndex
CREATE UNIQUE INDEX "DevReportEntry_reportId_messageId_key" ON "DevReportEntry"("reportId", "messageId");

-- AddForeignKey
ALTER TABLE "DevReport" ADD CONSTRAINT "DevReport_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DevReportEntry" ADD CONSTRAINT "DevReportEntry_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "DevReport"("id") ON DELETE CASCADE ON UPDATE CASCADE;
