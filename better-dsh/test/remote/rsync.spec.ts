import { it, expect } from 'vitest'
import { mkdir, writeFile, readFile, readdir, access, stat, chmod, symlink, lstat, readlink, copyFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes, createHash } from 'node:crypto'
import { RemoteDriver } from '../../src/remote/driver.ts'
import { sshArgv } from '../../src/remote/ssh-targets.ts'
import { withSshFixture } from './ssh-fixture.ts'
import { createRealRemoteHarness } from './real-harness.ts'

// Break caught: missing relay/default dry-run or replacing native delta with full copy.
it('relays native binary delta with origin-held BYO identities and defaults to dry-run/no-delete', async () => {
  await withSshFixture(async f => {
    const calls: {connection:Parameters<typeof sshArgv>[0],options:Parameters<typeof sshArgv>[1]}[] = []
    const destination = {...f.destination,host:'fixture-native',proxyJump:'fixture-jump'}
    const d = new RemoteDriver({ rsyncSshArgv: (c, o) => {calls.push({connection:c,options:o});return f.isolate(sshArgv(c, o))} })
    const timings: {elapsedMs:number,exit:number|null}[]=[]
    const sync=async(...args:Parameters<RemoteDriver['rsync']>)=>{
      const started=Date.now(),result=await d.rsync(...args)
      timings.push({elapsedMs:Date.now()-started,exit:result.exit})
      await writeFile('../.scratch/task-1/task7-fix4-native-timings.json',JSON.stringify(timings,null,2)+'\n')
      return result
    }
    try {
      const src = join(f.directory, "source with 'quote"), dst = join(f.directory, "destination with 'quote")
      await mkdir(src); await mkdir(dst)
      const file = join(src, 'binary'), bytes = randomBytes(8 * 1024 * 1024)
      await writeFile(file, bytes); await writeFile(join(dst, 'extra'), 'keep')
      d.registerSsh('byossh:source', f.jump); d.registerSsh('byossh:destination', destination)
      expect(d).toHaveProperty('rsync')
      const req = { src: `byossh:source:${src}/`, dst: `byossh:destination:${dst}/` }
      const dry = await sync(req, new AbortController().signal)
      expect(dry).toMatchObject({ exit: 0, dryRun: true, delete: false })
      await expect(access(join(dst, 'binary'))).rejects.toThrow()
      expect(await readFile(join(dst, 'extra'), 'utf8')).toBe('keep')
      const initial = await sync({ ...req, dryRun: false }, new AbortController().signal)
      expect(initial).toMatchObject({ exit: 0, literalBytes: bytes.length })
      bytes.write('SMALL-DELTA\0\xff', 4000000, 'latin1'); await writeFile(file, bytes)
      // Explicit content check defeats same-size/same-second quick-check.
      const { utimes } = await import('node:fs/promises'); const old = await stat(join(dst, 'binary')); await utimes(file, old.atime, new Date(old.mtimeMs + 5000))
      const delta = await sync({ ...req, dryRun: false }, new AbortController().signal)
      expect(delta.exit).toBe(0); expect(delta.matchedBytes).toBeGreaterThan(8e6)
      expect(delta.transferredBytes).toBeLessThan(bytes.length / 4)
      expect(createHash('sha256').update(await readFile(join(dst, 'binary'))).digest('hex')).toBe(createHash('sha256').update(await readFile(file)).digest('hex'))
      expect(await readFile(join(dst, 'extra'), 'utf8')).toBe('keep')
      expect(await readdir(dst)).toEqual(['binary', 'extra'])
      for(const call of calls) {
        expect(call.connection).toEqual(call.connection.host==='fixture-native'?destination:f.jump)
        expect(call.options?.extraArgs).toContain('-a');expect(call.options?.extraArgs).toContain('ForwardAgent=no');if(!call.options?.extraArgs?.includes('ControlMaster=yes')&&!call.options?.extraArgs?.includes('forward'))expect(call.options?.extraArgs).toContain('ControlPath=none')
        expect(call.options?.command ?? '').not.toContain(f.jump.key);expect(call.options?.command ?? '').not.toContain(destination.key)
      }
      const sourceHash=createHash('sha256').update(await readFile(file)).digest('hex'),destinationHash=createHash('sha256').update(await readFile(join(dst,'binary'))).digest('hex')
      await writeFile('../.scratch/task-1/task7-native-evidence.json',JSON.stringify({size:bytes.length,initial,delta,sourceHash,destinationHash,sourceConnection:{host:f.jump.host,user:f.jump.user,port:f.jump.port,identity:'origin fixture source key'},destinationConnection:{host:destination.host,user:destination.user,port:destination.port,identity:'origin fixture destination key',proxyJump:destination.proxyJump},canonicalCalls:calls.length},null,2)+'\n')
      await writeFile(join(src,'excluded\nfile'),'skip')
      const deleted=await sync({...req,dryRun:false,delete:true,excludes:['excluded\nfile']},new AbortController().signal)
      expect(deleted.exit).toBe(0);expect(deleted.itemizedChanges.some(line=>line.startsWith('*deleting'))).toBe(true)
      expect(await readdir(dst)).toEqual(['binary'])
      await sync({src:`byossh:source:${src}`,dst:`byossh:destination:${dst}`,dryRun:false,preserve:false,excludes:['excluded\nfile']},new AbortController().signal)
      expect(createHash('sha256').update(await readFile(join(dst,"source with 'quote",'binary'))).digest('hex')).toBe(sourceHash)
    } finally { await d.dispose() }
  })
// Five complete relay lifecycles now each include receiving clock-only SSH roundtrips.
}, 60000)

// Break caught: forcing all routes through directory-only daemon; losing native options/slash semantics.
it('supports local-SSH file/new destination plus native excludes/delete/preserve and directory slash semantics', async () => {
  await withSshFixture(async f => {
    const d = new RemoteDriver({ rsyncSshArgv: (c, o) => f.isolate(sshArgv(c, o)) })
    try {
      d.registerSsh('byossh:remote', f.destination)
      const src = join(f.directory, 'tree'), dst = join(f.directory, 'native-new')
      await mkdir(src); await writeFile(join(src, 'keep'), 'binary\0\xff'); await chmod(join(src, 'keep'), 0o751)
      await writeFile(join(src, 'excluded'), 'skip'); await symlink('keep', join(src, 'link'))
      const odd="odd\nname'$(false)";await writeFile(join(src,odd),'byte-safe name')
      const req = { src: src + '/', dst: `byossh:remote:${dst}/`, excludes: ['excluded'] }
      expect(await d.rsync(req, new AbortController().signal)).toMatchObject({ dryRun: true, exit: 0 })
      await expect(access(dst)).rejects.toThrow()
      expect(await d.rsync({ ...req, dryRun: false }, new AbortController().signal)).toMatchObject({ exit: 0, preserve: true })
      expect(await readFile(join(dst, 'keep'), 'utf8')).toBe('binary\0\xff')
      expect(await readFile(join(dst,odd),'utf8')).toBe('byte-safe name')
      expect((await stat(join(dst, 'keep'))).mode & 0o777).toBe(0o751)
      expect((await lstat(join(dst, 'link'))).isSymbolicLink()).toBe(true); expect(await readlink(join(dst, 'link'))).toBe('keep')
      await expect(access(join(dst, 'excluded'))).rejects.toThrow()
      await writeFile(join(dst, 'extra'), 'remove'); await d.rsync({ ...req, dryRun: false, delete: true }, new AbortController().signal)
      await expect(access(join(dst, 'extra'))).rejects.toThrow()
      const file = join(f.directory, 'download with quote\'file')
      expect(await d.rsync({ src: `byossh:remote:${dst}/keep`, dst: file, dryRun: false, preserve: false }, new AbortController().signal)).toMatchObject({ exit: 0, preserve: false })
      expect(await readFile(file, 'utf8')).toBe('binary\0\xff')
      const key=join(f.directory,"origin key with ' quote");await copyFile(f.destination.key,key)
      d.registerSsh('byossh:user-host',{...f.destination,key,host:f.destination.user+'@127.0.0.1',user:undefined})
      const userHostFile=join(f.directory,'%USER%user-host-file')
      expect(await d.rsync({src:file,dst:`byossh:user-host:${userHostFile}`,dryRun:false},new AbortController().signal)).toMatchObject({exit:0})
      expect(await readFile(userHostFile,'utf8')).toBe('binary\0\xff')
      const nested = join(f.directory, 'nested'); await mkdir(nested)
      await d.rsync({ src, dst: `byossh:remote:${nested}`, dryRun: false }, new AbortController().signal)
      expect(await readFile(join(nested, 'tree', 'keep'), 'utf8')).toBe('binary\0\xff')
      const bad = await d.rsync({ src: join(f.directory, 'missing'), dst: `byossh:remote:${nested}`, dryRun: false }, new AbortController().signal)
      expect(bad.exit).not.toBe(0); expect(bad.stderr).toContain('No such file')
      await expect(d.rsync({ src: `docker:x:${src}`, dst: file }, new AbortController().signal)).rejects.toThrow(/SSH/)
    } finally { await d.dispose() }
  })
}, 40000)

// Break caught: action still rejected by real tool schema, or nonzero rsync presented as success.
it('declares native rsync Surface and returns defaults through the real scoped tool', async () => {
  await withSshFixture(async f => {
    const h = await createRealRemoteHarness({ copies: 1, driverOptions: { rsyncSshArgv: (c, o) => f.isolate(sshArgv(c, o)) } })
    try {
      const a = await h.createAgent('rsync-tool'), src = join(f.directory, 'source'), dst = join(f.directory, 'dest')
      await mkdir(src); await mkdir(dst); await writeFile(join(src, 'test'), 'content')
      await h.invoke(a, { target: 'byossh:dest', ssh: f.destination })
      expect(h.visibleTools(a).find(t => t.name === 'remote')!.description).toContain('rsync')
      const receipt = JSON.parse((await h.invoke(a, { action: 'rsync', src: src + '/', dst: `byossh:dest:${dst}/` })).text)
      expect(receipt).toMatchObject({ action: 'rsync', dryRun: true, delete: false, exit: 0 })
      await expect(access(join(dst, 'test'))).rejects.toThrow()
      await expect(h.invoke(a, { action: 'rsync', src, dst: `byossh:dest:${dst}`, cmd: 'true' })).rejects.toThrow(/cannot be combined/)
      await expect(h.invoke(a, { action: 'rsync', src: join(src, 'missing'), dst: `byossh:dest:${dst}`, dryRun: false })).rejects.toThrow(/No such file/)
    } finally { await h.dispose() }
  })
}, 30000)

it('uses the full canonical IPv6 SSH identity without rsync misparsing the host',async()=>{
  await withSshFixture(async f=>{
    const d=new RemoteDriver({rsyncSshArgv:(c,o)=>f.isolate(sshArgv(c,o))})
    try {
      d.registerSsh('byossh:v6',{...f.destination,host:'::1'})
      const src=join(f.directory,'binary'),dst=join(f.directory,'v6-copy');await writeFile(src,Buffer.from([0,255,128,13,10]))
      expect(await d.rsync({src,dst:`byossh:v6:${dst}`,dryRun:false},new AbortController().signal)).toMatchObject({exit:0})
      expect(await readFile(dst)).toEqual(await readFile(src))
    } finally {await d.dispose()}
  },{ipv6:true})
},10000)
