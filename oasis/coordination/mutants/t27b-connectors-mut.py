import subprocess, pathlib, sys
UV="/private/tmp/oasis-t01-tools/bin/uv"
GR="src/gates/graph_read.py"; GW="src/gates/graph_write.py"; GA="src/gates/google_api.py"
M=[
("search select missing ccRecipients",GR,'bodyPreview,toRecipients,ccRecipients"','bodyPreview,toRecipients"'),
("unread select missing ccRecipients",GR,'receivedDateTime,toRecipients,ccRecipients"\n','receivedDateTime,toRecipients"\n'),
("graph addresses not lower-cased",GR,"        address = address_raw.strip().lower()","        address = address_raw.strip()"),
("graph account_address always empty",GR,"        return mail_raw.strip().lower()",'        return ""'),
("graph upn fallback off",GR,"        return upn_raw.strip().lower()",'        return ""'),
("graph /me failure fails read",GR,'    except ConnectError:\n        return ""\n    mail_raw','    except ConnectError:\n        raise\n    mail_raw'),
("gmail Cc header not fetched",GA,'        ("metadataHeaders", "Cc"),\n    ]\n    return f"{_GMAIL_BASE}/messages/{message_id}?{urlencode(params)}"','    ]\n    return f"{_GMAIL_BASE}/messages/{message_id}?{urlencode(params)}"'),
("gmail To header not fetched",GA,'        ("metadataHeaders", "To"),\n        ("metadataHeaders", "Cc"),\n    ]\n    return f"{_GMAIL_BASE}/messages/{message_id}?{urlencode(params)}"','        ("metadataHeaders", "Cc"),\n    ]\n    return f"{_GMAIL_BASE}/messages/{message_id}?{urlencode(params)}"'),
("gmail account_address always empty",GA,'    return email_raw.strip().lower() if isinstance(email_raw, str) and email_raw else ""','    return ""'),
("gmail profile failure fails read",GA,'    except ConnectError:\n        return ""\n    email_raw','    except ConnectError:\n        raise\n    email_raw'),
("gmail reply_all without to",GA,"    if reply_all and not to:\n        raise ConnectError","    if False:\n        raise ConnectError"),
("gmail to recomputed",GA,"        to_addresses: tuple[str, ...] = tuple(to) if to else ()","        to_addresses: tuple[str, ...] = (context.reply_to,)"),
("gmail cc dropped",GA,"        cc_addresses: tuple[str, ...] = tuple(cc) if cc else ()","        cc_addresses: tuple[str, ...] = ()"),
("outlook createReplyAll used",GW,"/createReply\"\n","/{'createReplyAll' if reply_all else 'createReply'}\"\n"),
("outlook reply_all without to",GW,"    if reply_all and not to:\n        raise ConnectError","    if False:\n        raise ConnectError"),
("outlook PATCH skipped",GW,"        if reply_all:\n            patch_url","        if False:\n            patch_url"),
("outlook cc dropped on send",GW,"for address in cc_list],","for address in []],"),
("outlook to dropped on send",GW,'"toRecipients": [{"emailAddress": {"address": address}} for address in to_list],','"toRecipients": [],'),
("outlook address logged",GW,"    cc_list = list(cc) if reply_all and cc else []\n","    cc_list = list(cc) if reply_all and cc else []\n    __import__('logging').getLogger('gates').warning('to=%s cc=%s', to_list, cc_list)\n"),
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
