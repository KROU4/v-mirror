"""
Причёски, добавленные в поздних патчах, отсутствуют в словаре имён WolvenKit,
поэтому regex по путям их не находит. Игра адресует файлы хешем FNV-1a 64 от пути
(в нижнем регистре), так что достаём их по хешу.

  python -I tools/extract/hair_by_hash.py --game "G:\\Cyberpunk 2077" --wk "C:\\tools\\wk\\WolvenKit.CLI.exe" --work C:\\tmp\\cp-work

Дописывает найденное в tools/local/hair/app_to_mesh.json и выгружает меши в glb.
Запускать после export_hair.ps1.
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "tools" / "local" / "hair"


def fnv1a64(s: str) -> int:
    h = 0xCBF29CE484222325
    for b in s.lower().encode("utf-8"):
        h ^= b
        h = (h * 0x100000001B3) & 0xFFFFFFFFFFFFFFFF
    return h


def run(cmd: list[str]) -> subprocess.CompletedProcess:
    r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="ignore")
    if r.returncode != 0:
        print(f"  ! {Path(cmd[0]).name} {cmd[1]} -> код {r.returncode}: {(r.stderr or r.stdout).strip()[:300]}")
    return r


def extract_by_hash(wk: str, game: Path, paths: list[str], dest: Path) -> dict[str, Path]:
    """Достаёт файлы по хешам путей; возвращает путь -> локальный файл.
    Файлы раскладываются по исходным папкам, чтобы одинаковые имена из разных
    каталогов не затирали друг друга."""
    dest.mkdir(parents=True, exist_ok=True)
    found: dict[str, Path] = {}
    for p in paths:
        target = dest / Path(p.replace("\\", "/"))
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.exists():
            found[p] = target
            continue
        h = fnv1a64(p)
        tmp = dest / f"_{h}"
        if tmp.exists():
            shutil.rmtree(tmp)
        for arch in ("archive/pc/content", "archive/pc/ep1"):
            run([wk, "extract", str(game / arch), "-o", str(tmp), "--hash", str(h)])
            files = [f for f in tmp.rglob("*") if f.is_file()] if tmp.exists() else []
            if files:
                shutil.move(str(files[0]), target)
                found[p] = target
                break
        shutil.rmtree(tmp, ignore_errors=True)
    return found


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--game", required=True)
    ap.add_argument("--wk", required=True)
    ap.add_argument("--work", required=True)
    a = ap.parse_args()
    game, work = Path(a.game), Path(a.work)

    a2m_path = OUT / "app_to_mesh.json"
    a2m: dict[str, list[str]] = json.loads(a2m_path.read_text(encoding="utf-8-sig")) if a2m_path.exists() else {}
    a2m = {k: (v if isinstance(v, list) else [v]) for k, v in a2m.items()}

    wanted: set[str] = set()
    for g in ("male", "female"):
        cc = json.loads((work / "cc_json" / f"{g}_cco_ep1.inkcharcustomization.json").read_text(encoding="utf-8"))
        for item in cc["Data"]["RootChunk"]["headCustomizationOptions"]:
            d = item.get("Data") or {}
            if not str(d.get("name", {}).get("$value", "")).startswith("hair_color"):
                continue
            r = (d.get("resource") or {}).get("DepotPath", {})
            r = r.get("$value") if isinstance(r, dict) else r
            # *_fpp — вид от первого лица, для описания не нужен
            if r and str(r).endswith(".app") and "_fpp" not in str(r) and Path(str(r).replace("\\", "/")).stem not in a2m:
                wanted.add(str(r))
    print("app без соответствия:", len(wanted))

    app_dir = work / "hair_app_hash"
    apps = extract_by_hash(a.wk, game, sorted(wanted), app_dir)
    print("достали app:", len(apps))
    json_dir = work / "hair_app_hash_json"
    json_dir.mkdir(parents=True, exist_ok=True)  # WolvenKit не создаёт папку вывода сам
    run([a.wk, "convert", "serialize", str(app_dir), "-o", str(json_dir)])

    rx = re.compile(r'"\$value":\s*"(base\\\\characters\\\\common\\\\hair\\\\[^"]+?\.mesh)"')
    new_meshes: set[str] = set()
    for p, f in apps.items():
        # serialize сохраняет относительную структуру папок
        rel = f.relative_to(app_dir)
        j = json_dir / rel.parent / (f.name + ".json")
        if not j.exists():
            hits = list(json_dir.rglob(f.name + ".json"))
            if len(hits) != 1:
                continue
            j = hits[0]
        meshes = sorted({m.replace("\\\\", "\\") for m in rx.findall(j.read_text(encoding="utf-8", errors="ignore"))
                         if not re.search(r"shadow|_fpp", m)})
        if not meshes:
            continue  # не затираем известное соответствие пустым списком
        a2m[Path(p.replace("\\", "/")).stem] = meshes
        new_meshes.update(meshes)
    a2m_path.write_text(json.dumps(a2m, indent=1), encoding="utf-8")

    have = {f.stem for f in OUT.glob("*.glb")}
    todo = [m for m in sorted(new_meshes) if Path(m.replace("\\", "/")).stem not in have]
    print("новых мешей:", len(todo))
    mesh_dir = work / "hair_mesh_hash"
    shutil.rmtree(mesh_dir, ignore_errors=True)
    got = extract_by_hash(a.wk, game, todo, mesh_dir)
    if got:
        run([a.wk, "export", str(mesh_dir), "-o", str(OUT), "--gamepath", str(game)])
    for f in OUT.rglob("*.glb"):
        if f.parent != OUT:
            if (OUT / f.name).exists():
                print(f"  ! {f.name}: уже есть меш с таким именем, оставляю прежний")
                continue
            shutil.move(str(f), OUT / f.name)
    names = sorted(f.name for f in OUT.glob("*.glb"))
    (OUT / "index.json").write_text(json.dumps(names, indent=1), encoding="utf-8")
    print("glb всего:", len(names))


if __name__ == "__main__":
    main()
