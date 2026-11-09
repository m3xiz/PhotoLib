"""Construction de la requête SQL de recherche.

Modèle : (filtre mots-clés en ET/OU/exclusif) ET (plage de dates) ET (nom de
fichier) ET (titre) ET (légende)
- keyword_mode='and' : la photo doit avoir TOUS les mots-clés sélectionnés
  (elle peut aussi en avoir d'autres en plus)
- keyword_mode='or'  : la photo doit avoir AU MOINS UN des mots-clés
- exclusive=True : la photo doit avoir EXACTEMENT ces mots-clés, aucun de
  plus, aucun de moins -- prime sur keyword_mode (l'exclusivité implique
  déjà "tous ces mots-clés", le choix ET/OU n'a plus de sens dans ce cas).
Tous ces groupes sont toujours combinés en ET entre eux -- c'est l'usage
naturel ("keywords X et/ou Y, ET pris en 2022, ET nom contient IMG_, ET
titre contient plage").
"""

SORT_OPTIONS = {
    "date_desc": "p.date_taken DESC NULLS LAST, p.relpath DESC",
    "date_asc": "p.date_taken ASC NULLS LAST, p.relpath ASC",
}


# List of RAW file extensions to exclude unless requested
RAW_EXTENSIONS = ["cr2", "nef", "arw", "dng", "raf", "orf", "rw2"]

def build_search_query(
    keywords,
    keyword_mode='and',
    exclusive=False,
    date_from=None,
    date_to=None,
    filename=None,
    title=None,
    caption=None,
    show_raw=False,
    sort='date_desc',
    page=1,
    page_size=60
):
    """Build SQL query for search.

    Parameters correspond to the API query parameters. Returns a tuple of:
        - sql: the SELECT statement with LIMIT/OFFSET applied
        - params_page: list of parameters for that statement
        - count_sql: statement used to compute total result count
        - params: base parameters (used by count_sql)
    """
    # Normalize keyword list
    keywords = [k.strip() for k in (keywords or []) if k.strip()]
    where = []
    params = []

    base = "SELECT p.* FROM photos p"

    if keywords and exclusive:
        # La photo doit avoir CE(S) mot(s)-clé(s) et RIEN d'autre : le
        # nombre de tags correspondants = nombre demandé, ET le nombre
        # total de tags de la photo = nombre demandé (donc pas d'extra).
        placeholders = ",".join("?" for _ in keywords)
        base += f"""
            JOIN (
                SELECT pt.photo_id FROM photo_tags pt
                JOIN tags t ON t.id = pt.tag_id
                GROUP BY pt.photo_id
                HAVING COUNT(DISTINCT CASE WHEN t.name IN ({placeholders})
                                            THEN t.id END) = ?
                   AND COUNT(DISTINCT t.id) = ?
            ) kw ON kw.photo_id = p.id
        """
        params.extend(keywords)
        params.append(len(keywords))
        params.append(len(keywords))
    elif keywords:
        placeholders = ",".join("?" for _ in keywords)
        if keyword_mode == "or":
            base += f"""
                JOIN (
                    SELECT DISTINCT pt.photo_id FROM photo_tags pt
                    JOIN tags t ON t.id = pt.tag_id
                    WHERE t.name IN ({placeholders})
                ) kw ON kw.photo_id = p.id
            """
            params.extend(keywords)
        else:  # and
            base += f"""
                JOIN (
                    SELECT pt.photo_id FROM photo_tags pt
                    JOIN tags t ON t.id = pt.tag_id
                    WHERE t.name IN ({placeholders})
                    GROUP BY pt.photo_id
                    HAVING COUNT(DISTINCT t.id) = ?
                ) kw ON kw.photo_id = p.id
            """
            params.extend(keywords)
            params.append(len(keywords))

    if date_from:
        where.append("p.date_taken >= ?")
        params.append(date_from)
    if date_to:
        # inclusif jusqu'à la fin de la journée si seule une date (pas d'heure) est fournie
        where.append("p.date_taken <= ?")
        params.append(date_to if "T" in date_to else date_to + "T23:59:59")
    if filename:
        where.append("p.filename LIKE ? ESCAPE '\\'")
        escaped = filename.replace("%", r"\%").replace("_", r"\_")
        params.append(f"%{escaped}%")

    # Filter out RAW files unless requested
    if not show_raw:
        raw_patterns = [f"%.{e}" for e in RAW_EXTENSIONS]
        where.append('NOT (' + ' OR '.join(["LOWER(p.filename) LIKE ?"]*len(RAW_EXTENSIONS)) + ')')
        params.extend(raw_patterns)
    if title:
        where.append("p.title LIKE ? ESCAPE '\\'")
        escaped = title.replace("%", r"\%").replace("_", r"\_")
        params.append(f"%{escaped}%")
    if caption:
        where.append("p.caption LIKE ? ESCAPE '\\'")
        escaped = caption.replace("%", r"\%").replace("_", r"\_")
        params.append(f"%{escaped}%")

    sql = base
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY " + SORT_OPTIONS.get(sort, SORT_OPTIONS["date_desc"])

    count_sql = f"SELECT COUNT(*) c FROM ({sql}) t"

    offset = max(0, (page - 1) * page_size)
    sql += " LIMIT ? OFFSET ?"
    params_page = params + [page_size, offset]

    return sql, params_page, count_sql, params
