use std::{env, fs, path::Path, time::Instant};

use loro::{ExportMode, LoroDoc, ToJson};
use serde_json::{json, Value};

fn write(path: &Path, bytes: &[u8]) -> Result<(), Box<dyn std::error::Error>> {
    fs::write(path, bytes)?;
    Ok(())
}

fn seed(out_dir: &Path) -> Result<(), Box<dyn std::error::Error>> {
    fs::create_dir_all(out_dir)?;
    let doc = LoroDoc::new();
    doc.set_peer_id(10)?;

    let recipe = doc.get_map("recipe");
    recipe.insert("id", "recipe-lentil-42")?;
    recipe.insert("title", "Soupe de lentilles — 東京 🍲")?;

    let ingredients = doc.get_movable_list("ingredient-order");
    for (index, id) in ["ing-onion-7", "ing-stock-8", "ing-lentils-9"].iter().enumerate() {
        ingredients.insert(index, *id)?;
    }
    for (id, name, amount) in [
        ("ing-onion-7", "oignon 🧅", "1"),
        ("ing-stock-8", "bouillon de légumes", "1 L"),
        ("ing-lentils-9", "lentilles rouges", "200 g"),
    ] {
        let item = doc.get_map(format!("ingredient:{id}"));
        item.insert("id", id)?;
        item.insert("name", name)?;
        item.insert("amount", amount)?;
        item.insert("deleted", false)?;
    }

    let steps = doc.get_movable_list("step-order");
    for (index, id) in ["step-prep-1", "step-simmer-2", "step-finish-3"].iter().enumerate() {
        steps.insert(index, *id)?;
    }
    for (id, text) in [
        ("step-prep-1", "Émincer l’oignon 🧅"),
        ("step-simmer-2", "Laisser mijoter 20 minutes."),
        ("step-finish-3", "Ajouter les herbes 🌿"),
    ] {
        let step = doc.get_map(format!("step:{id}"));
        step.insert("id", id)?;
        step.insert("text", text)?;
    }

    write(&out_dir.join("rust-base.snapshot"), &doc.export(ExportMode::Snapshot)?)?;
    Ok(())
}

fn state(doc: &LoroDoc) -> Value {
    doc.get_deep_value().to_json_value()
}

fn verify_cross_version_state(value: &Value) -> Result<(), Box<dyn std::error::Error>> {
    let title = value["recipe"]["title"].as_str().unwrap_or_default();
    assert!(
        title == "Rust recipe 🍲 — 東京" || title == "Web recipe 🥘 — café",
        "same-field title conflict was not resolved to either writer: {title}"
    );
    assert_eq!(value["ingredient-order"], json!(["ing-stock-8", "ing-lentils-9", "ing-onion-7"]));
    assert_eq!(value["step-order"], json!(["step-simmer-2", "step-serve-4", "step-prep-1"]));
    assert_eq!(value["ingredient:ing-stock-8"]["id"], "ing-stock-8");
    assert_eq!(value["ingredient:ing-stock-8"]["deleted"], true);
    assert_eq!(value["ingredient:ing-stock-8"]["amount"], "900 ml");
    assert_eq!(value["ingredient:ing-onion-7"]["id"], "ing-onion-7");
    assert_eq!(value["step:step-serve-4"]["text"], "Ajouter du persil 🌿 — 東京");
    assert_eq!(value["step:step-prep-1"]["text"], "Émincer l’oignon 🧅");
    Ok(())
}

fn import_snapshot(bytes: &[u8]) -> Result<LoroDoc, Box<dyn std::error::Error>> {
    let doc = LoroDoc::new();
    doc.import(bytes)?;
    Ok(doc)
}

fn merge(
    base_path: &Path,
    web_update_path: &Path,
    web_snapshot_path: &Path,
    out_dir: &Path,
) -> Result<(), Box<dyn std::error::Error>> {
    fs::create_dir_all(out_dir)?;
    let started = Instant::now();
    let base = fs::read(base_path)?;
    let web_update = fs::read(web_update_path)?;
    let web_snapshot = fs::read(web_snapshot_path)?;

    let doc = import_snapshot(&base)?;
    let base_version = doc.oplog_vv();
    doc.set_peer_id(101)?;
    doc.get_map("recipe").insert("title", "Rust recipe 🍲 — 東京")?;
    doc.get_movable_list("ingredient-order").mov(0, 2)?;
    doc.get_map("ingredient:ing-stock-8").insert("deleted", true)?;
    doc.get_map("recipe").insert("rust-note", "naïve 🌾")?;

    let rust_update = doc.export(ExportMode::updates(&base_version))?;
    doc.import(&web_update)?;

    let web_snapshot_doc = import_snapshot(&web_snapshot)?;
    let web_update_doc = import_snapshot(&base)?;
    web_update_doc.import(&web_update)?;
    assert_eq!(state(&web_snapshot_doc), state(&web_update_doc));

    let final_state = state(&doc);
    verify_cross_version_state(&final_state)?;

    for updates in [
        vec![&web_update, &rust_update],
        vec![&rust_update, &web_update],
        vec![&web_update, &rust_update, &web_update],
    ] {
        let replica = import_snapshot(&base)?;
        for update in updates {
            replica.import(update)?;
        }
        assert_eq!(state(&replica), final_state);
    }
    let duplicate_delivery = import_snapshot(&base)?;
    duplicate_delivery.import(&rust_update)?;
    duplicate_delivery.import(&web_update)?;
    duplicate_delivery.import(&rust_update)?;
    assert_eq!(state(&duplicate_delivery), final_state);

    write(&out_dir.join("rust-update.bin"), &rust_update)?;
    write(&out_dir.join("rust-final.snapshot"), &doc.export(ExportMode::Snapshot)?)?;
    fs::write(out_dir.join("rust-final.json"), serde_json::to_vec(&final_state)?)?;
    println!(
        "{}",
        json!({
            "loroCore": "1.10.3",
            "webUpdateBytes": web_update.len(),
            "webSnapshotBytes": web_snapshot.len(),
            "rustUpdateBytes": rust_update.len(),
            "rustFinalSnapshotBytes": fs::metadata(out_dir.join("rust-final.snapshot"))?.len(),
            "mergeRuntimeMs": started.elapsed().as_secs_f64() * 1000.0,
            "state": final_state,
            "duplicateAndOrderChecks": 4,
            "webSnapshotEqualsWebUpdateState": true
        })
    );
    Ok(())
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("seed") if args.len() == 3 => seed(Path::new(&args[2])),
        Some("merge") if args.len() == 6 => merge(
            Path::new(&args[2]),
            Path::new(&args[3]),
            Path::new(&args[4]),
            Path::new(&args[5]),
        ),
        _ => Err("usage: loro-wire-rust seed <out-dir> | merge <base> <web-update> <web-snapshot> <out-dir>".into()),
    }
}
