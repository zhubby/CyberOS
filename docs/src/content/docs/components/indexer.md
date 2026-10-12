---
title: Indexer
description: NAS 遍历、增量索引、FTS5 和失败保护。
type: explanation
status: current
audience: [developer, operator]
sourceOfTruth: [apps/indexer/src/service.rs, apps/indexer/src/scanner.rs, apps/indexer/src/extractor.rs, apps/indexer/src/storage.rs, packages/db/src/repositories/index-search.ts]
sidebar:
  order: 4
---

Indexer 是 Rust 常驻服务。API、文件操作和 downloader 把成功变更写入持久化 SQLite queue，inotify 事件经 750ms 防抖和祖先路径合并后进入同一队列；每 30 分钟还会安排一次全量 reconciliation。任务通过 generation、lease 和退避重试保证崩溃恢复，SQLite 写入由单独数据库线程串行执行。

文件访问使用 dirfd、Linux `openat2`、`RESOLVE_BENEATH` 和 no-symlink 约束。全量扫描只有在遍历完整且 device/inode 与 required mount 的 source/UUID/fstype 始终稳定时才清理旧 generation；掉线、权限错误、watcher degraded 和进程中断都会保留旧索引并请求重试或校准。

正文提取支持有限读取的纯文本、`pdftotext`、DOCX、XLSX、PPTX；OCR 按 root 开启，仅在 PDF 内嵌可见文本不足时使用 `chi_sim+eng`。命令超时、输出限制、ZIP/XML 展开限制和页数限制阻止单个文档耗尽服务资源。搜索写入 `indexed_content_fts`，使用 `unicode61`、prefix 和额外的 NFKC CJK unigram/bigram terms；旧 `indexed_text` 在后台分批复制并逐 root 切换。
