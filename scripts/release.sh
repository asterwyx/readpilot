#!/usr/bin/env bash
# ReadPilot 版本发布脚本
# 用法：./scripts/release.sh <version>
# 例如：./scripts/release.sh 0.2.0
#
# 流程：
#   1. 校验版本号格式（语义化版本 MAJOR.MINOR.PATCH）
#   2. 更新 manifest.json 的 version 字段
#   3. 在 CHANGELOG.md 中将 [Unreleased] 转为正式版本条目
#   4. 创建 git commit（消息格式 release: v{version}）
#   5. 创建并推送 git tag（v{version}），触发 GitHub Actions 发布工作流
set -euo pipefail

# ==================== 工具函数 ====================

# 打印错误并退出
die() {
    echo "::error:: $*" >&2
    exit 1
}

# 获取仓库根目录
repo_root() {
    git rev-parse --show-toplevel
}

# ==================== 参数校验 ====================

VERSION="${1:-}"
[ -n "$VERSION" ] || die "用法：$0 <version>  (例如：0.2.0)"

# 校验语义化版本号格式：MAJOR.MINOR.PATCH（纯数字，无前缀 v）
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    die "版本号格式错误：$VERSION (应为 MAJOR.MINOR.PATCH，例如 0.2.0)"
fi

# 确认在 git 仓库内
ROOT="$(repo_root)"
cd "$ROOT"

# 确认工作区干净（允许有未跟踪的 release 脚本本身等无关文件）
if ! git diff --quiet || ! git diff --cached --quiet; then
    die "工作区有未提交的改动，请先提交或 stash 后再发布。"
fi

# 确认 tag 不已存在
if git rev-parse -q --verify "refs/tags/v${VERSION}" >/dev/null; then
    die "tag v${VERSION} 已存在，请检查版本号。"
fi

# ==================== 更新 manifest.json ====================

MANIFEST="$ROOT/manifest.json"
[ -f "$MANIFEST" ] || die "未找到 manifest.json"

# 用 jq 原地更新 version 字段
jq --arg v "$VERSION" '.version = $v' "$MANIFEST" > "$MANIFEST.tmp"
mv "$MANIFEST.tmp" "$MANIFEST"

echo "✓ manifest.json 版本号已更新为 $VERSION"

# ==================== 更新 CHANGELOG.md ====================

CHANGELOG="$ROOT/CHANGELOG.md"
[ -f "$CHANGELOG" ] || die "未找到 CHANGELOG.md"

# 获取今日日期（YYYY-MM-DD）
TODAY=$(date +%Y-%m-%d)

# 将 [Unreleased] 段落转为正式版本条目，并在顶部插入新的空 [Unreleased] 段。
# 逻辑：找到 `## [Unreleased]` 行，在其前插入新的空 Unreleased 段，
# 并将该行替换为 `## [version] - date`。
awk -v ver="$VERSION" -v date="$TODAY" '
    # 已插入标记，避免重复
    BEGIN { inserted=0 }
    /^## \[Unreleased\]$/ {
        if (!inserted) {
            printf "## [Unreleased]\n\n### 新增\n\n- （待记录）\n\n"
            inserted=1
        }
        # 当前行替换为版本标题，后续内容（原 Unreleased 条目）归入版本段
        printf "## [%s] - %s\n", ver, date
        next
    }
    { print }
' "$CHANGELOG" > "$CHANGELOG.tmp"
mv "$CHANGELOG.tmp" "$CHANGELOG"

echo "✓ CHANGELOG.md 已添加 v${VERSION} 条目"

# ==================== 提交并打 tag ====================

git add "$MANIFEST" "$CHANGELOG"
git commit -m "release: v${VERSION}" --no-verify

git tag "v${VERSION}"

echo "✓ 已创建 commit 和 tag v${VERSION}"

# ==================== 推送 ====================

# 推送当前分支
git push origin HEAD
# 推送 tag（触发 GitHub Actions 发布工作流）
git push origin "v${VERSION}"

echo "✓ 已推送至 origin 并触发 release 工作流"
echo "发布完成：v${VERSION}"
