import subprocess, pathlib, sys
UV="/private/tmp/oasis-t01-tools/bin/uv"
GR="src/gates/graph_read.py"; GW="src/gates/graph_write.py"; GA="src/gates/google_api.py"
M=[
("get_mail skips account address",GR,"        result = replace(header, account_address=account_address)\n    except ConnectError:\n        with contextlib.suppress(audit.AuditError):\n            audit.append_event(connector.name, person, \"read_mail\", \"failed\"","        result = header\n    except ConnectError:\n        with contextlib.suppress(audit.AuditError):\n            audit.append_event(connector.name, person, \"read_mail\", \"failed\""),
("get_mail selects bodyPreview",GR,'_GET_MAIL_SELECT = "id,subject,from,receivedDateTime,toRecipients,ccRecipients"','_GET_MAIL_SELECT = "id,subject,from,receivedDateTime,bodyPreview,toRecipients,ccRecipients"'),
("get_mail invalid id not refused",GR,"    connector = load_connector(\"outlook\", catalog_dir=catalog_dir)\n    if not is_valid_message_id(message_id):\n        raise","    connector = load_connector(\"outlook\", catalog_dir=catalog_dir)\n    if False:\n        raise"),
("id validator allows control chars",GR,"    return not _CONTROL_CHARS_RE.search(message_id)","    return True"),
("id validator no length cap",GR,"    if not message_id or len(message_id) > MESSAGE_ID_MAX_LENGTH:","    if not message_id:"),
("get_mail unquoted id",GR,"/me/messages/{quote(message_id, safe='')}?{urlencode(params)}","/me/messages/{message_id}?{urlencode(params)}"),
("get_mail drops cc",GR,"        to_addresses=_recipient_addresses(item, \"toRecipients\"),\n        cc_addresses=_recipient_addresses(item, \"ccRecipients\"),\n    )\n\n\nasync def get_mail","        to_addresses=_recipient_addresses(item, \"toRecipients\"),\n    )\n\n\nasync def get_mail"),
("gmail_get skips account",GA,"    return replace(messages[0], account_address=account_address)","    return messages[0]"),
("gmail_get invalid id not refused",GA,"    connector = load_connector(\"gmail\", catalog_dir=catalog_dir)\n    if not is_valid_message_id(message_id):\n        raise ConnectError(error_text(connector, \"invalid\"), kind=\"invalid\")\n    if not re.fullmatch","    connector = load_connector(\"gmail\", catalog_dir=catalog_dir)\n    if False:\n        raise ConnectError(error_text(connector, \"invalid\"), kind=\"invalid\")\n    if not re.fullmatch"),
("gmail_get id charset off",GA,'    if not re.fullmatch(r"[A-Za-z0-9_-]{1,512}", message_id):','    if False:'),
("gmail_get empty not raised",GA,"    if not messages:\n        raise ConnectError(error_text(connector, \"not_found\")","    if False:\n        raise ConnectError(error_text(connector, \"not_found\")"),
("gmail Cc header not fetched",GA,'        ("metadataHeaders", "Cc"),\n    ]\n    return f"{_GMAIL_BASE}/messages/{message_id}?{urlencode(params)}"','    ]\n    return f"{_GMAIL_BASE}/messages/{message_id}?{urlencode(params)}"'),
("outlook can_do missing get_mail","catalog/outlook/connector.yaml","can_do: [read_mail, search_mail, get_mail]","can_do: [read_mail, search_mail]"),
("gmail can_do missing gmail_get","catalog/gmail/connector.yaml","can_do: [gmail_unread, gmail_search, gmail_get]","can_do: [gmail_unread, gmail_search]"),
]
only=sys.argv[1:]; out=[]
for name,f,a,b in M:
    if only and name not in only: continue
    p=pathlib.Path(f); s=p.read_text(); n=s.count(a)
    if n!=1: out.append(f"SKIP({n}) {name}"); print(out[-1],flush=True); continue
    p.write_text(s.replace(a,b,1))
    try: r=subprocess.run([UV,"run","--no-sync","pytest","-q","-x","-p","no:cacheprovider"],capture_output=True,text=True,timeout=600)
    finally: p.write_text(s)
    out.append(f"{'KILLED' if r.returncode!=0 else 'SURVIVED'} {name}"); print(out[-1],flush=True)
print("DONE")
