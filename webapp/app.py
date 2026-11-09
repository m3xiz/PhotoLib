#!/usr/bin/env python3
"""Webapp PhotoLib - API de recherche en lecture seule.
Lit une copie SQLite synchronisée depuis le serveur Samba (voir indexer/).
"""
import os
import sqlite3

import httpx
import yaml
from fastapi import FastAPI, HTTPException, Query

def _parse_bool(val: str | None) -> bool:
    """Coerce common UI checkbox values to a Python bool.
    Accepts 'on', 'true', '1', etc. Case‑insensitive.
    """
    if val is None:
        return False
    return val.lower() in ("true", "1", "t", "yes", "y", "on")
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

import query_builder

CONFIG_PATH = os.environ.get(
    "PHOTOLIB_WEB_CONFIG",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.yaml"),
)
with open(CONFIG_PATH) as f:
    CFG = yaml.safe_load(f)

app = FastAPI(title="PhotoLib Search")


def get_conn():
    # read-only, DB is a snapshot rsync'd from the indexer, don't write here
    conn = sqlite3.connect(f"file:{CFG['db_path']}?mode=ro", uri=True, timeout=10)
    conn.row_factory = sqlite3.Row
    return conn


def row_to_dict(row):
    d = dict(row)
    thumb = d.get("thumb_path")
    d["thumb_url"] = f"/api/thumb/{d['id']}" if thumb else None
    d["photo_url"] = CFG["photo_public_url_prefix"].rstrip("/") + "/" + d["relpath"]
    return d


@app.get("/api/tags")
def list_tags(q: str = Query("", description="Filtre texte pour autocomplétion")):
    conn = get_conn()
    try:
        # DISTINCT t.name via JOIN photo_tags : exclut les tags orphelins
        # (plus attachés à aucune photo, ex: après un retag qui a retiré
        # l'ancien mot-clé) qui resteraient sinon indéfiniment dans la table
        # tags même sans plus jamais être utilisés.
        if q:
            cur = conn.execute(
                """SELECT DISTINCT t.name FROM tags t
                   JOIN photo_tags pt ON pt.tag_id = t.id
                   WHERE t.name LIKE ? ORDER BY t.name LIMIT 50""",
                (f"%{q}%",),
            )
        else:
            cur = conn.execute(
                """SELECT DISTINCT t.name FROM tags t
                   JOIN photo_tags pt ON pt.tag_id = t.id
                   ORDER BY t.name LIMIT 1000"""
            )
        return {"tags": [r["name"] for r in cur.fetchall()]}
    finally:
        conn.close()


@app.get("/api/search")
def search(
    keywords: str = Query("", description="Mots-clés séparés par des virgules"),
    keyword_mode: str = Query("and", regex="^(and|or)$"),
    exclusive: bool = Query(False, description="Photos ayant EXACTEMENT ces mots‑clés, aucun autre"),
    date_from: str = Query(None),
    date_to: str = Query(None),
    filename: str = Query(None),
    title: str = Query(None, description="Filtre sur le titre (contient)"),
    caption: str = Query(None, description="Filtre sur la légende (contient)"),
    sort: str = Query("date_desc", regex="^(date_desc|date_asc)$"),
    page: int = Query(1, ge=1),
    page_size: int | None = Query(None),
    show_raw: str | None = Query(
        None,
        description="Inclure les fichiers RAW dans les résultats (UI sends 'on')",
    ),
):
    page_size = page_size or CFG.get("page_size_default", 60)
    page_size = min(page_size, CFG.get("page_size_max", 200))
    kw_list = [k for k in keywords.split(",") if k.strip()] if keywords else []

    # Normalize raw flag from UI string to boolean
    show_raw_flag = _parse_bool(show_raw)

    sql, params_page, count_sql, count_params = query_builder.build_search_query(
        keywords=kw_list,
        keyword_mode=keyword_mode,
        exclusive=exclusive,
        date_from=date_from,
        date_to=date_to,
        filename=filename,
        title=title,
        caption=caption,
        show_raw=show_raw_flag,
        sort=sort,
        page=page,
        page_size=page_size,
    )

    conn = get_conn()
    try:
        total = conn.execute(count_sql, count_params).fetchone()["c"]
        rows = conn.execute(sql, params_page).fetchall()
        return {
            "total": total,
            "page": page,
            "page_size": page_size,
            "results": [row_to_dict(r) for r in rows],
        }
    finally:
        conn.close()


@app.get("/api/thumb/{photo_id}")
def get_thumb(photo_id: int):
    conn = get_conn()
    try:
        row = conn.execute("SELECT thumb_path FROM photos WHERE id=?",
                            (photo_id,)).fetchone()
    finally:
        conn.close()
    if not row or not row["thumb_path"]:
        raise HTTPException(404, "Pas de miniature")
    path = os.path.join(CFG["thumbnail_dir"], row["thumb_path"])
    if not os.path.isfile(path):
        raise HTTPException(404, "Fichier miniature introuvable")
    return FileResponse(path, media_type="image/jpeg")


@app.get("/api/photo/{photo_id}")
def get_photo_detail(photo_id: int):
    """Détail complet d'une photo (pour la visionneuse) : métadonnées
    EXIF/IPTC (titre, légende, date) + mots-clés."""
    conn = get_conn()
    try:
        row = conn.execute("SELECT * FROM photos WHERE id=?", (photo_id,)).fetchone()
        if not row:
            raise HTTPException(404, "Photo introuvable")
        tag_rows = conn.execute(
            """SELECT t.name FROM photo_tags pt JOIN tags t ON t.id = pt.tag_id
               WHERE pt.photo_id = ? ORDER BY t.name""",
            (photo_id,),
        ).fetchall()
    finally:
        conn.close()
    d = row_to_dict(row)
    d["tags"] = [r["name"] for r in tag_rows]
    return d


@app.get("/api/status")
def status():
    conn = get_conn()
    try:
        row = conn.execute(
            "SELECT * FROM scan_log ORDER BY id DESC LIMIT 1"
        ).fetchone()
        total_photos = conn.execute("SELECT COUNT(*) c FROM photos").fetchone()["c"]
        total_tags = conn.execute("SELECT COUNT(*) c FROM tags").fetchone()["c"]
    finally:
        conn.close()
    return {
        "last_scan": dict(row) if row else None,
        "total_photos": total_photos,
        "total_tags": total_tags,
    }


@app.post("/api/trigger-scan")
def trigger_scan():
    url = CFG.get("indexer_trigger_url")
    if not url:
        raise HTTPException(400, "indexer_trigger_url non configuré")
    try:
        r = httpx.post(f"{url}/trigger-scan", timeout=10)
        r.raise_for_status()
        return r.json()
    except httpx.HTTPError as e:
        raise HTTPException(502, f"Indexeur injoignable: {e}")


static_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
app.mount("/", StaticFiles(directory=static_dir, html=True), name="static")
