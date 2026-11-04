# storage-tools — 安全文件路径与存储操作原语

`@cyberos/storage-tools` 提供 NAS 文件的目录/文本读取、元数据、哈希、受限变更、回收与回滚原语。它将逻辑 pool、相对路径、真实路径和实际文件操作的边界显式分开，供 API 与 capability-runtime 复用。

本包不访问业务数据库、不创建审批，也不把一次文件操作和 SQL 记录合成事务。调用方必须先完成业务授权、检查就绪，并在操作后保存审计、trash entry 和运行状态。

[返回工作空间总览](../README.md) · [包定义](package.json)

## 架构图

![文件读取、变更与存储池路径边界架构](docs/architecture.svg)

安全解析是实际读写链路的一部分。图中的 scope 是已选存储池的访问边界，不代表数据库或主机级权限。

## 源码导航

| 文件 | 职责 |
| --- | --- |
| [src/path-safety.ts](src/path-safety.ts) | realpath containment、相对路径、PathSafetyError、托管 iSCSI 保护 |
| [src/storage-scope.ts](src/storage-scope.ts) | pool scope、嵌套 pool 隔离、目标路径和 symlink segment 检查 |
| [src/read-tools.ts](src/read-tools.ts) | listDir、statPath、有限文本读取与搜索 |
| [src/metadata-tools.ts](src/metadata-tools.ts) | 元数据、MIME 推断、SHA-256 和重复候选 |
| [src/mutation-tools.ts](src/mutation-tools.ts) | mkdir/move/copy/trash/edit 授权/extract、恢复与回滚 |
| [src/index.ts](src/index.ts) | 公共导出 |

## 路径模型

`resolveSafeExistingPath(root, requestedPath)` 拒绝绝对输入，把根与候选解析为真实路径，确认结果仍在根内，并拒绝 `.cyberos/iscsi` 托管镜像。返回 rootRealPath、absolutePath、realPath 和归一化 relativePath。

目标尚不存在时不能直接 realpath 整个目标。`resolveSafeTargetPath` 先验证根与词法包含关系，再由具体变更操作检查父级 symlink、源目标关系和目标存在性。只调用目标解析函数不等于所有安全检查已完成。

`SafeStorageScope` 在整个 data namespace 内进一步限定选定 mountpoint，并排除嵌套的兄弟 pool。它会检查真实目录身份，但生产挂载的实际就绪还需上层配合 mountinfo 等检查。

不同函数对 symlink 的规则不同：读取解析允许解析到根内的真实对象；scope target 和特定 mutation 会明确检查路径段。不能笼统宣称本库在所有入口都禁止任何 symlink。

## 读取与元数据

`listDir` 列出文件类型、大小、mtime 和 isSafe，过滤托管 iSCSI 项，目录优先排序。isSafe 用于表示路径可访问性，不是用户身份授权。

`readText` 对读取字节有上限，默认 64 KiB，并返回 truncated。`statPath` 返回归一化路径与基本属性；`extractMetadata` 推断 MIME；`hashFile` 在安全路径内计算 SHA-256。MIME/图标分类不应成为可信执行或内容安全判断。

## 变更与恢复

| 操作 | 关键语义 |
| --- | --- |
| mkdir | 检查目标和父级路径，创建单个新目录 |
| move/rename/copy | 检查源、目标、包含关系与托管 iSCSI 后代，拒绝覆盖已存在目标 |
| trash | 移动到调用方提供的 state 回收站，返回 trash ID 与元数据供持久化 |
| restore | 使用持久 trash entry，由专门恢复函数处理；拒绝覆盖现有目标 |
| edit | `applyFileMutation` 仅完成编辑授权/目标核验；实际文本保存属于 API 编辑路径 |
| extract | 使用归档格式分支、条目与大小限制、安全路径和发布检查 |
| tag | 返回标签元数据；持久标签由调用方保存 |

上传/下载不是此 dispatcher 内的普通 apply 操作；调用方有单独写入与发布路径。回滚只接受 applied 记录并按操作类别处理：move/rename 逆向移动，某些新建结果移入回收站，edit 不支持回滚。

跨文件系统移动、归档子进程和中途失败有各自实现分支，应检查实际返回结果和目标状态；不能假定任意目录变更都具有文件系统事务级原子性。

## 归档与托管镜像

归档支持 zip/tar/gzip/rar 的对应路径，限制条目数和解压字节，检查逃逸、symlink 和目标。当前保护常量包括 10,000 条目与 2 GiB 解压字节；具体工具还需目标系统安装。

托管 iSCSI 镜像只能由 hostd 的对应管理链路处理。保护不止拦截镜像本身，还拒绝复制/移动包含镜像的祖先目录，避免把正在使用的 LUN 当普通用户文件处理。

## 开发与验证

```bash
npx vitest run packages/storage-tools
npm run typecheck
```

测试覆盖 traversal、symlink、scope、iSCSI、归档和变更行为。上层整合还需验证审批、挂载离线、数据库记录与回滚；真实 Linux 文件系统竞争和跨设备语义应单独验收。
