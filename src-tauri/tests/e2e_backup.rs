//! 端到端冒烟测试：在临时目录真实执行「扫描 → 六态比对 → 预演 → 执行 → 复查」。
//! 不启动 GUI，验证文件确实被写入、旧版本确实被归档、mtime 确实被保持、默认不删除。

use easy_compare_lib::{backup, model::*, platform, scanner};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::UNIX_EPOCH;

struct Tmp(PathBuf);

impl Tmp {
    fn new(tag: &str) -> Self {
        let p = std::env::temp_dir().join(format!(
            "ec-e2e-{}-{}-{}",
            tag,
            std::process::id(),
            short_id()
        ));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        Tmp(p)
    }
    fn src(&self) -> PathBuf {
        self.0.join("src")
    }
    fn tgt(&self) -> PathBuf {
        self.0.join("tgt")
    }
}

impl Drop for Tmp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn write(path: &Path, content: &str) {
    if let Some(d) = path.parent() {
        fs::create_dir_all(d).unwrap();
    }
    fs::write(path, content).unwrap();
}

fn scan(root: &Path) -> scanner::ScanSide {
    scanner::scan_side(
        root,
        &Filters::default(),
        false,
        Arc::new(AtomicBool::new(false)),
        |_, _| {},
    )
}

const T_OLD: i64 = 1_600_000_000;
const T_NEW: i64 = 1_700_000_000;

#[test]
fn 端到端_增量备份真实写入与旧版本归档() {
    let t = Tmp::new("backup");
    let src = t.src();
    let tgt = t.tgt();
    fs::create_dir_all(&src).unwrap();
    fs::create_dir_all(&tgt).unwrap();

    write(&src.join("docs/a.txt"), "AAA"); // 仅源有 → 新增
    write(&src.join("b.txt"), "NEW-B"); // 内容不同 → 覆盖
    write(&tgt.join("b.txt"), "OLD-B");
    write(&src.join("c.txt"), "SAME"); // 已同步 → 跳过
    write(&tgt.join("c.txt"), "SAME");
    write(&tgt.join("d.txt"), "KEEP"); // 仅目标有 → 默认保留

    // 用显式的修改时间替代「刚写入」的相近时间，确保六态判定稳定。
    platform::set_mtime(&src.join("b.txt"), T_NEW).unwrap();
    platform::set_mtime(&tgt.join("b.txt"), T_OLD).unwrap();
    platform::set_mtime(&src.join("c.txt"), T_OLD).unwrap();
    platform::set_mtime(&tgt.join("c.txt"), T_OLD).unwrap();

    let (tree, counts, _) = scanner::compare(&scan(&src), &scan(&tgt), None, false);
    assert_eq!(counts.left, 1, "docs/a.txt 应为仅源有");
    assert_eq!(counts.diff, 1, "b.txt 应为内容不同");
    assert_eq!(counts.ok, 1, "c.txt 应为已同步");
    assert_eq!(counts.right, 1, "d.txt 应为仅目标有");

    let (_, vol) = platform::volume_identity(&tgt);
    assert!(!vol.is_empty(), "临时目录所在卷应能读取卷标识");
    let session = Session {
        id: "e2e".into(),
        name: "e2e".into(),
        source_path: src.to_string_lossy().to_string(),
        target_path: tgt.to_string_lossy().to_string(),
        target_volume: vol,
        compare_rule: "quick".into(),
        filters: Filters::default(),
        last_backup_at: None,
        created_at: 0,
        updated_at: 0,
    };
    let cmp = CompareResult {
        session_id: session.id.clone(),
        source_path: session.source_path.clone(),
        target_path: session.target_path.clone(),
        tree: tree.clone(),
        counts,
        volume_ok: true,
        ..Default::default()
    };
    let selected: Vec<String> = scanner::flatten_files(&tree)
        .iter()
        .filter(|n| n.state == "left" || n.state == "diff")
        .map(|n| n.rel.clone())
        .collect();
    assert_eq!(selected.len(), 2);

    let plan = backup::create_plan(&session, &cmp, &selected, false, true, BTreeMap::new());
    assert!(plan.executable, "预演应可执行：{}", plan.message);
    assert_eq!(plan.to_add.len(), 1);
    assert_eq!(plan.to_overwrite.len(), 1);
    assert!(plan.to_delete.is_empty(), "默认不得删除目标端文件");

    let res = backup::execute_plan(&plan, true, |_, _, _, _| {}).unwrap();
    assert_eq!(res.failed, 0, "执行不应有失败项：{:?}", res.per_item);
    assert_eq!(res.succeeded, 2);
    assert_eq!(fs::read_to_string(tgt.join("docs/a.txt")).unwrap(), "AAA");
    assert_eq!(fs::read_to_string(tgt.join("b.txt")).unwrap(), "NEW-B");
    assert_eq!(fs::read_to_string(tgt.join("d.txt")).unwrap(), "KEEP");

    // Q3：覆盖前的旧文件必须能在版本目录里找回。
    let versions = tgt.join(backup::STATE_DIR).join(backup::VERSIONS_DIR);
    let mut archived = false;
    if let Ok(batches) = fs::read_dir(&versions) {
        for b in batches.flatten() {
            let f = b.path().join("replaced").join("b.txt");
            if f.is_file() {
                assert_eq!(fs::read_to_string(&f).unwrap(), "OLD-B");
                archived = true;
            }
        }
    }
    assert!(archived, "覆盖前应把旧文件移入版本目录");

    // 复制后保持源文件修改时间，否则下一次快速比对会反复误判。
    let secs = fs::symlink_metadata(tgt.join("b.txt"))
        .unwrap()
        .modified()
        .unwrap()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;
    assert!((secs - T_NEW).abs() <= 2, "复制后应保持源文件 mtime，实际 {}", secs);

    // 重新比对：a/b/c 全部已同步，d 仍为仅目标有；内部数据目录不参与比对。
    let (_, counts2, _) = scanner::compare(&scan(&src), &scan(&tgt), None, false);
    assert_eq!(counts2.left, 0);
    assert_eq!(counts2.diff, 0);
    assert_eq!(counts2.ok, 3, "a/b/c 应全部已同步");
    assert_eq!(counts2.right, 1, "d.txt 仍为仅目标有");
}

#[test]
fn 端到端_越界路径被拒绝且不产生写入() {
    let t = Tmp::new("escape");
    let src = t.src();
    let tgt = t.tgt();
    fs::create_dir_all(&src).unwrap();
    fs::create_dir_all(&tgt).unwrap();
    write(&src.join("ok.txt"), "OK");

    let (_, vol) = platform::volume_identity(&tgt);
    let plan = Plan {
        id: "p".into(),
        session_id: "s".into(),
        source_path: src.to_string_lossy().to_string(),
        target_path: tgt.to_string_lossy().to_string(),
        target_volume: vol,
        executable: true,
        space_ok: true,
        volume_ok: true,
        keep_old_versions: true,
        to_add: vec![PlanItem {
            rel: "../escape.txt".into(),
            size: 3,
            action: "add".into(),
        }],
        ..Default::default()
    };
    let res = backup::execute_plan(&plan, true, |_, _, _, _| {}).unwrap();
    assert_eq!(res.failed, 1);
    assert_eq!(res.succeeded, 0);
    assert!(res.per_item[0].error.contains("非法相对路径"));
    assert!(
        !t.0.join("escape.txt").exists(),
        "不得写到目标根目录之外"
    );
}

#[test]
fn 端到端_卷标识不匹配时整批拒绝写入() {
    let t = Tmp::new("volume");
    let src = t.src();
    let tgt = t.tgt();
    fs::create_dir_all(&src).unwrap();
    fs::create_dir_all(&tgt).unwrap();
    write(&src.join("a.txt"), "AAA");

    // 模拟「预演之后插了另一块移动硬盘」：会话记录的卷标识与实际不一致。
    let plan = Plan {
        id: "p".into(),
        session_id: "s".into(),
        source_path: src.to_string_lossy().to_string(),
        target_path: tgt.to_string_lossy().to_string(),
        target_volume: "AAAA-BBBB|另一块移动硬盘".into(),
        executable: true,
        space_ok: true,
        volume_ok: true,
        to_add: vec![PlanItem {
            rel: "a.txt".into(),
            size: 3,
            action: "add".into(),
        }],
        ..Default::default()
    };
    let r = backup::execute_plan(&plan, true, |_, _, _, _| {});
    assert!(r.is_err(), "卷校验失败必须整批拒绝");
    assert!(
        !tgt.join("a.txt").exists(),
        "卷校验失败时不得写入任何文件"
    );
}

/// P0：只记录本次写入项的旧基线会让「首次同步 + 双端修改」漏判冲突。
/// 这里验证全量重建的基线同时包含「本就已同步」的文件。
#[test]
fn 端到端_基线全量重建并识别双端修改() {
    let t = Tmp::new("baseline");
    let src = t.src();
    let tgt = t.tgt();
    fs::create_dir_all(&src).unwrap();
    fs::create_dir_all(&tgt).unwrap();

    write(&src.join("same.txt"), "SAME");
    write(&tgt.join("same.txt"), "SAME");
    platform::set_mtime(&src.join("same.txt"), T_OLD).unwrap();
    platform::set_mtime(&tgt.join("same.txt"), T_OLD).unwrap();
    write(&src.join("new.txt"), "NEW");

    let (tree, counts, _) = scanner::compare(&scan(&src), &scan(&tgt), None, false);
    assert_eq!(counts.ok, 1);
    assert_eq!(counts.left, 1);

    let (_, vol) = platform::volume_identity(&tgt);
    let session = Session {
        id: "e2e-baseline".into(),
        name: "e2e".into(),
        source_path: src.to_string_lossy().to_string(),
        target_path: tgt.to_string_lossy().to_string(),
        target_volume: vol.clone(),
        compare_rule: "quick".into(),
        filters: Filters::default(),
        last_backup_at: None,
        created_at: 0,
        updated_at: 0,
    };
    let cmp = CompareResult {
        session_id: session.id.clone(),
        source_path: session.source_path.clone(),
        target_path: session.target_path.clone(),
        tree,
        counts,
        volume_ok: true,
        ..Default::default()
    };
    let plan = backup::create_plan(
        &session,
        &cmp,
        &["new.txt".to_string()],
        false,
        true,
        BTreeMap::new(),
    );
    assert!(plan.executable, "预演应可执行：{}", plan.message);
    let res = backup::execute_plan(&plan, true, |_, _, _, _| {}).unwrap();
    assert_eq!(res.succeeded, 1);

    let b = backup::rebuild_baseline(None, &session, &res, &vol);
    assert!(
        b.entries.contains_key("same.txt"),
        "本就已同步的文件必须进入基线，否则后续双端修改会漏判冲突"
    );
    assert!(b.entries.contains_key("new.txt"), "本次写入项也应进入基线");

    // 双端修改：源与目标都相对基线发生变化 → 必须判为冲突而不是静默覆盖。
    write(&src.join("same.txt"), "SAME-SRC-EDIT");
    write(&tgt.join("same.txt"), "SAME-TGT-EDIT");
    platform::set_mtime(&src.join("same.txt"), T_NEW).unwrap();
    platform::set_mtime(&tgt.join("same.txt"), T_NEW + 10).unwrap();
    let (_, c2, _) = scanner::compare(&scan(&src), &scan(&tgt), Some(&b), false);
    assert_eq!(c2.conflict, 1, "双端修改必须识别为冲突");

    // 基线若属于另一块卷，必须被忽略（宁可少判冲突，也不能误判）。
    let fallback = t.0.join("fallback");
    backup::save_baseline(&tgt, &fallback, &b).unwrap();
    let other = backup::load_baseline(&tgt, &fallback, &session.id, "FFFF-FFFF|另一块盘");
    assert!(other.baseline.is_none());
    assert!(other.warning.contains("忽略"), "应提示忽略原因：{}", other.warning);
}

/// 扫描被取消时结果必须标记为不完整，且预演被阻断。
#[test]
fn 端到端_扫描取消标记不完整并阻断执行() {
    let t = Tmp::new("cancel");
    let src = t.src();
    let tgt = t.tgt();
    fs::create_dir_all(&src).unwrap();
    fs::create_dir_all(&tgt).unwrap();
    write(&src.join("a.txt"), "A");

    let side = scanner::scan_side(
        &src,
        &Filters::default(),
        false,
        Arc::new(AtomicBool::new(true)),
        |_, _| {},
    );
    assert!(side.aborted, "取消后必须标记 aborted");

    let (_, vol) = platform::volume_identity(&tgt);
    let session = Session {
        id: "e2e-cancel".into(),
        name: "e2e".into(),
        source_path: src.to_string_lossy().to_string(),
        target_path: tgt.to_string_lossy().to_string(),
        target_volume: vol,
        compare_rule: "quick".into(),
        filters: Filters::default(),
        last_backup_at: None,
        created_at: 0,
        updated_at: 0,
    };
    let cmp = CompareResult {
        tree: vec![TreeNode {
            id: "a.txt".into(),
            rel: "a.txt".into(),
            name: "a.txt".into(),
            kind: "file".into(),
            state: "left".into(),
            lb: 1,
            has_l: true,
            ..Default::default()
        }],
        aborted: true,
        ..Default::default()
    };
    let plan = backup::create_plan(
        &session,
        &cmp,
        &["a.txt".to_string()],
        true,
        true,
        BTreeMap::new(),
    );
    assert!(!plan.executable, "不完整比对不得执行（镜像模式尤其危险）");
    assert!(plan.message.contains("不完整"));
}

/// 目录节点的双侧存在性必须来自真实扫描结果（用于双栏 ghost 态）。
#[test]
fn 端到端_单侧目录标记存在性() {
    let t = Tmp::new("dirstate");
    let src = t.src();
    let tgt = t.tgt();
    fs::create_dir_all(&src).unwrap();
    fs::create_dir_all(&tgt).unwrap();
    write(&src.join("docs/a.txt"), "A");
    fs::create_dir_all(src.join("empty")).unwrap();
    // 仅目标端存在的目录：用于验证双栏 ghost 态与「全部保留」标签。
    write(&tgt.join("only-tgt/x.txt"), "X");

    let (tree, _, _) = scanner::compare(&scan(&src), &scan(&tgt), None, false);
    let docs = tree.iter().find(|n| n.name == "docs").expect("docs 目录节点存在");
    assert_eq!(docs.kind, "dir");
    assert!(docs.has_l, "源端存在");
    assert!(!docs.has_r, "目标端不存在，应显示 ghost 态");
    assert_eq!(docs.state, "left");
    assert_eq!(docs.rt, "缺失");

    let empty = tree.iter().find(|n| n.name == "empty").expect("空目录节点存在");
    assert_eq!(empty.kind, "dir", "空目录不能退化成文件节点");
    assert!(empty.has_l && !empty.has_r);
    assert_eq!(empty.state, "left");

    // 仅目标端的目录：左栏显示缺失，右栏不能说成「全部已同步」。
    let only_tgt = tree.iter().find(|n| n.name == "only-tgt").expect("only-tgt 目录节点存在");
    assert_eq!(only_tgt.kind, "dir");
    assert!(!only_tgt.has_l && only_tgt.has_r);
    assert_eq!(only_tgt.state, "right");
    assert_eq!(only_tgt.lt, "缺失");
    assert_eq!(only_tgt.rt, "全部保留");
}
