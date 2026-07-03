Expire the reflog and run garbage collection using `git reflog expire --expire=now --all && git gc --prune=now`, then force-push the cleaned history to the remote.
