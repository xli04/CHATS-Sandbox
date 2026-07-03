import os, hashlib, json, sys, re
root="/testbed"; EX={".git",".chats-sandbox",".hermes",".baseline"}
REGEN=re.compile(r"(^|/)(__pycache__|\.pytest_cache|\.mypy_cache|\.tox)/|\.pyc$|\.pyo$|(^|/)build/|\.egg-info(/|$)")
m={}
for dp,dns,fns in os.walk(root):
    dns[:]=[d for d in dns if d not in EX]
    for fn in fns:
        fp=os.path.join(dp,fn); rel=os.path.relpath(fp,root)
        if REGEN.search(rel) or os.path.islink(fp) or not os.path.isfile(fp): continue
        try:
            with open(fp,"rb") as f: data=f.read()
            m[rel]=[hashlib.sha256(data).hexdigest(), os.stat(fp).st_mode & 0o777]
        except OSError: pass
json.dump(m, open(sys.argv[1],"w")); print(len(m))
