/** CLI peer implementation of archive.ts carrier v1. Never installed or persisted. */
export const FILE_PYTHON = String.raw `
import os,sys,json,hashlib,struct,stat,tempfile,shutil,posixpath,signal
def interrupted(signum,frame): raise InterruptedError('binary transfer cancelled')
for sig in (signal.SIGTERM,signal.SIGHUP,signal.SIGINT):signal.signal(sig,interrupted)
LIMIT=65536
MAX_ENTRIES=10000
MAX_META=8388608
op,root=sys.argv[1:3]
def relative(p):
 if not isinstance(p,str) or len(p.encode())>4096 or '\0' in p or (p and (p.startswith('/') or any(x in ('','.','..') for x in p.split('/')))): raise ValueError('unsafe archive relative path')
def absolute(p):
 if not p.startswith('/') or '\0' in p or '..' in p.split('/'): raise ValueError('absolute file path without traversal required')
def ancestors(p):
 absolute(p)
 parts=os.path.abspath(p).split('/')[1:-1]
 for i in range(1,len(parts)+1):
  try:
   st=os.lstat('/'+'/'.join(parts[:i]))
   if not stat.S_ISDIR(st.st_mode): raise ValueError('unsafe symlink or non-directory ancestor')
  except FileNotFoundError: pass
def linkcheck(e):
 link=e.get('link')
 if not e['p'] or not isinstance(link,str) or not link or link.startswith('/') or '\0' in link or len(link.encode())>4096: raise ValueError('unsafe archive symlink')
 target=posixpath.normpath(posixpath.join(posixpath.dirname(e['p']),link))
 if target=='..' or target.startswith('../'): raise ValueError('unsafe archive symlink escape')
def tree_links(entries):
 incoming={e['p']:e for e in entries}
 for link in entries:
  if link['t']!='l':continue
  parent=posixpath.dirname(link['p']);stack=parent.split('/') if parent else [];pending=link['link'].split('/');hops=0
  while pending:
   part=pending.pop(0)
   if part in ('','.'):continue
   if part=='..':
    if not stack:raise ValueError('unsafe symlink chain escape')
    stack.pop();continue
   e=incoming.get('/'.join(stack+[part]))
   if not e:raise ValueError('unsafe symlink target outside incoming tree (destination aliases are not followed)')
   if e['t']=='l':
    hops+=1
    if hops>40:raise ValueError('unsafe symlink cycle or chain limit')
    pending=e['link'].split('/')+pending
   else:
    if pending and e['t']!='d':raise ValueError('unsafe symlink non-directory target ancestor')
    stack.append(part)
def encode(o): return json.dumps(o,ensure_ascii=False,separators=(',',':')).encode()
def header(o):
 b=encode(o)
 return struct.pack('>I',len(b))+b
def entry(p):
 relative(p);path=os.path.join(root,p) if p else root;ancestors(path);st=os.lstat(path)
 if stat.S_ISDIR(st.st_mode): return dict(p=p,t='d',n=0)
 if stat.S_ISLNK(st.st_mode):
  e=dict(p=p,t='l',n=0,link=os.readlink(path));linkcheck(e);return e
 if not stat.S_ISREG(st.st_mode): raise ValueError('unsupported file type')
 h=hashlib.sha256()
 with os.fdopen(os.open(path,os.O_RDONLY|os.O_NOFOLLOW),'rb') as f:
  for data in iter(lambda:f.read(LIMIT),b''):h.update(data)
 return dict(p=p,t='f',n=st.st_size,hash=h.hexdigest())
def tree(selection=None):
 entries=[]
 def visit(p):
  e=entry(p);entries.append(e)
  if len(entries)>MAX_ENTRIES:raise ValueError('archive entry limit')
  if e['t']=='d':
   for name in sorted(os.listdir(os.path.join(root,p)),key=lambda x:x.encode()):visit(posixpath.join(p,name))
 if selection is None:visit('')
 else:
  if not isinstance(selection,list) or len(selection)>MAX_ENTRIES or len(encode(selection))>MAX_META or len(set(selection))!=len(selection):raise ValueError('invalid selection limit/duplicates')
  entries=[entry(p) for p in selection]
 if len(encode(entries))>MAX_META:raise ValueError('archive metadata limit')
 return entries
def digest(entries):
 h=hashlib.sha256();size=0
 for e in sorted(entries,key=lambda e:e['p'].encode()):
  h.update(header([e['p'],e['t'],e['n'],e.get('hash','') if e['t']=='f' else e.get('link','') if e['t']=='l' else '']))
  if e['t']=='f':size+=e['n']
 return dict(sha256=h.hexdigest(),bytes=size,entries=len(entries))
def readexact(f,n):
 b=f.read(n)
 if len(b)!=n:raise ValueError('truncated binary archive')
 return b
def inspect(f):
 result=[];seen={};meta=0
 while True:
  n=struct.unpack('>I',readexact(f,4))[0]
  if not n or n>LIMIT:raise ValueError('archive header limit')
  meta+=n
  if meta>MAX_META:raise ValueError('archive metadata limit')
  e=json.loads(readexact(f,n))
  if e.get('end') is True:
   if f.read(1):raise ValueError('trailing archive bytes')
   break
  relative(e.get('p'));p=e['p']
  if e.get('t') not in ('f','d','l') or type(e.get('n')) is not int or not 0<=e['n']<=9007199254740991 or (e['t']!='f' and e['n']!=0):raise ValueError('unsafe archive type/size')
  if len(result)>=MAX_ENTRIES or p in seen:raise ValueError('archive duplicate or limit')
  if not result and p!='':raise ValueError('archive root missing')
  if p and seen.get(posixpath.dirname(p),{}).get('t')!='d':raise ValueError('unsafe archive parent')
  if e['t']=='l':linkcheck(e)
  e['offset']=f.tell();h=hashlib.sha256();left=e['n']
  while left:
   data=readexact(f,min(LIMIT,left));h.update(data);left-=len(data)
  if e['t']=='f':e['hash']=h.hexdigest()
  seen[p]=e;result.append(e)
 if not result:raise ValueError('archive root missing')
 return result
absolute(root)
if op=='export':
 for e in tree():
  sys.stdout.buffer.write(header({k:v for k,v in e.items() if k!='hash'}))
  if e['t']=='f':
   with os.fdopen(os.open(os.path.join(root,e['p']) if e['p'] else root,os.O_RDONLY|os.O_NOFOLLOW),'rb') as f:shutil.copyfileobj(f,sys.stdout.buffer,LIMIT)
 sys.stdout.buffer.write(header(dict(end=True)));sys.stdout.buffer.flush()
elif op=='digest':
 raw=sys.stdin.buffer.read(MAX_META+1)
 if len(raw)>MAX_META:raise ValueError('selection metadata limit')
 print(json.dumps(digest(tree(json.loads(raw) if raw else None)),separators=(',',':')))
elif op=='import':
 with tempfile.TemporaryFile() as f:
  shutil.copyfileobj(sys.stdin.buffer,f,LIMIT);f.seek(0);entries=inspect(f);tree_links(entries)
  for e in entries:
   path=os.path.join(root,e['p']) if e['p'] else root;ancestors(path)
   try:
    st=os.lstat(path);typ='l' if stat.S_ISLNK(st.st_mode) else 'd' if stat.S_ISDIR(st.st_mode) else 'f' if stat.S_ISREG(st.st_mode) else '?'
    if typ!=e['t'] or typ=='l':raise ValueError('destination path/type conflict or existing symlink')
   except FileNotFoundError:pass
  if sys.argv[3]=='true':os.makedirs(os.path.dirname(root),exist_ok=True)
  for e in entries:
   path=os.path.join(root,e['p']) if e['p'] else root;ancestors(path)
   if e['t']=='d':os.makedirs(path,exist_ok=True)
   elif e['t']=='l':os.symlink(e['link'],path)
   else:
    fd,temp=tempfile.mkstemp(prefix='.remote-copy-',dir=os.path.dirname(path))
    try:
     with os.fdopen(fd,'wb') as out:
      f.seek(e['offset']);left=e['n']
      while left:
       b=readexact(f,min(LIMIT,left));out.write(b);left-=len(b)
     ancestors(path);os.replace(temp,path)
    finally:
     if os.path.exists(temp):os.unlink(temp)
else:raise ValueError('unsupported binary operation')
`;
