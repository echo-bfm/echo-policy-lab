import loadMujoco from './vendor/mujoco.js';
import {Assets,json,verifiedBinary} from './assets.js?v=20261113-recovery';
import {frameMetrics} from './metrics.js';
export const widths={robot_root_quat:4,estimator_history:6100,reference_encoder_input:1900,robot_key_body:195,short_interactions:13650,short_valid:50,long_interactions:81900,long_valid:30,previous_latents:256};
const f = Math.fround;
const cross = (a,b) => [f(f(a[1]*b[2])-f(a[2]*b[1])),f(f(a[2]*b[0])-f(a[0]*b[2])),f(f(a[0]*b[1])-f(a[1]*b[0]))];
function normalized(q) { const n=f(Math.sqrt(q.reduce((s,x)=>f(s+f(x*x)),0))); return q.map(x=>f(x/n)); }
function rotate(q,v,inverse=false) {
  const xyz=q.slice(1), c=cross(xyz,v), dot=xyz.reduce((s,x,i)=>f(s+f(x*v[i])),0), a=f(f(2*f(q[0]*q[0]))-1);
  return v.map((x,i)=>f(f(f(x*a)+(inverse?-1:1)*f(f(c[i]*q[0])*2))+f(f(xyz[i]*dot)*2)));
}
function rot6(q) {q=normalized(q);const [w,x,y,z]=q, s=f(2/q.reduce((a,v)=>f(a+f(v*v)),0));
  return [f(1-f(s*f(f(y*y)+f(z*z)))),f(s*f(f(x*y)+f(z*w))),f(s*f(f(x*z)-f(y*w))),
    f(s*f(f(x*y)-f(z*w))),f(1-f(s*f(f(x*x)+f(z*z)))),f(s*f(f(y*z)+f(x*w)))];}

export class Engine {
  static async create(status,{loadLegacy=true,assets:preparedAssets=null}={}) {
    const started=performance.now(),startupPhases={},assetsPromise=preparedAssets??Assets.create(status);
    const [mj,assets,config,[sceneBytes,kinBytes]]=await Promise.all([
      verifiedBinary('./vendor/mujoco.wasm',10143561,'832597ae0a0e306c97ed43d2a9bbca033cf3e547eced410fb9011d87a68d4207',status)
        .then(wasmBinary=>loadMujoco({wasmBinary})).then(mj=>{startupPhases.wasmMs=performance.now()-started;return mj;}),assetsPromise,json('./assets/config.json'),
      assetsPromise.then(assets=>Promise.all(['scene','kinematics'].map(name=>assets.bytes(name))))
    ]);
    startupPhases.assetsMs=performance.now()-started;
    if(mj.mj_versionString()!==config.mujocoVersion)throw new Error('MuJoCo version mismatch');
    const vfs=new mj.MjVFS(),files=[];let model,kin;
    try {
      // addBuffer boxes every byte through Embind. MEMFS copies the same verified
      // arrays in bulk; the empty VFS permits MuJoCo to read these temporary files.
      for(const [path,bytes] of [['/tmp/policy-scene.mjb',sceneBytes],['/tmp/policy-kinematics.mjb',kinBytes]]){
        mj.FS.writeFile(path,bytes);files.push(path);
      }
      startupPhases.vfsMs=performance.now()-started-startupPhases.assetsMs;
      model=mj.MjModel.from_binary_path(files[0],vfs);kin=mj.MjModel.from_binary_path(files[1],vfs);
    } finally { for(const path of files)mj.FS.unlink(path);vfs.delete(); }
    startupPhases.modelsMs=performance.now()-started-startupPhases.assetsMs;
    const [refQpos,refBodies,refN,refPRE]=loadLegacy?await Promise.all([
      assets.array('reference-qpos',Float64Array),assets.array('reference-bodies'),assets.array('references-N'),assets.array('references-PRE')
    ]):[null,null,null,null];
    const engine=new Engine(mj,assets,config,model,kin,refQpos,refBodies,loadLegacy?{N:refN,PRE:refPRE}:null);
    engine.startupPhases={...startupPhases,totalMs:performance.now()-started};return engine;
  }
  constructor(mj,assets,config,model,kin,refQpos,refBodies,refs){Object.assign(this,{mj,assets,config,model,kin,refQpos,refBodies,refs});this.visual=new mj.MjData(model);this.ghost=new mj.MjData(model);this.standing=this.makeStanding();}
  makeStanding(){
    // Same neutral posture and collision-derived clearance as echo-live. Build
    // it from this experiment's own model and joint map, without changing its
    // canonical motion reset or borrowing another checkpoint's observations.
    const {mj,model:m,visual:d,config:c}=this,qpos=new Float64Array(m.nq);
    qpos[2]=1;qpos[3]=1;c.qposIds.forEach((id,i)=>qpos[id]=f(c.offset[i]));
    d.qpos.set(qpos);mj.mj_forward(m,d);
    if(c.feet.some(id=>m.geom_type[id]!==3))throw new Error('Standing clearance expects capsule feet');
    const bottom=Math.min(...c.feet.map(id=>d.geom_xpos[id*3+2]-m.geom_size[id*3]-Math.abs(d.geom_xmat[id*9+8])*m.geom_size[id*3+1]));
    qpos[2]+=.002-bottom;
    const frame=Float32Array.from([...qpos.slice(0,3),1,0,0,0,1,0,...c.qposIds.map(id=>qpos[id])]);
    const reference=new Float32Array(1900);for(let i=0;i<50;i++)reference.set(frame,i*38);
    return {qpos,reference};
  }
  physics(mu){
    if(!Number.isFinite(mu)||mu<.3||mu>2||Math.abs(mu*100-Math.round(mu*100))>1e-7)throw new Error('Friction must be 0.30–2.00 in steps of 0.01');
    this.model.geom_friction[this.config.floor*3]=0;
    for(const id of this.config.feet)this.model.geom_friction[id*3]=mu;
    this.mu=mu;
  }
  environment(label,long=[],options={}){return new Environment(this,label,long,options);}
  pose(qpos,referenceFrame=0){
    return this.poseAt(qpos,referenceFrame===null?this.standing.qpos:this.refQpos.subarray(referenceFrame*this.config.nq,(referenceFrame+1)*this.config.nq));
  }
  poseAt(qpos,referenceQpos){
    const {mj,model,visual,ghost,config:c}=this;
    visual.qpos.set(qpos);mj.mj_kinematics(model,visual);
    ghost.qpos.set(referenceQpos);mj.mj_kinematics(model,ghost);
    return {bodyPos:visual.xpos.slice(),bodyQuat:visual.xquat.slice(),ghostPos:ghost.xpos.slice(),ghostQuat:ghost.xquat.slice()};
  }
  renderModel(){
    const m=this.model,geoms=[];
    for(let i=0;i<m.ngeom;i++)if(m.geom_group[i]===2&&m.geom_dataid[i]>=0){
      const mesh=m.geom_dataid[i],start=m.mesh_vertadr[mesh]*3,end=start+m.mesh_vertnum[mesh]*3,fa=m.mesh_faceadr[mesh]*3;
      geoms.push({body:m.geom_bodyid[i],pos:m.geom_pos.slice(i*3,i*3+3),quat:m.geom_quat.slice(i*4,i*4+4),vertices:m.mesh_vert.slice(start,end),faces:m.mesh_face.slice(fa,fa+m.mesh_facenum[mesh]*3)});
    }
    return {geoms,bodyParents:this.config.bodyParents,bodyIds:this.config.bodyIds,initial:this.pose(this.standing.qpos,null)};
  }
}
export class Environment {
  constructor(engine,label,long=[],options={}){
    const {mj,config,model,kin}=engine;
    Object.assign(this,{engine,mj,config,model,kin,label,memory:options.memory!==false});
    this.data=new mj.MjData(model);this.kinData=new mj.MjData(kin);
    this.jp=new mj.DoubleBuffer(3*kin.nv);this.jr=new mj.DoubleBuffer(3*kin.nv);
    this.inputs=Object.fromEntries(Object.entries(widths).map(([k,n])=>[k,new Float32Array(n)]));
    this.history=new Float32Array(6100);this.prev=new Float32Array(29);this.latents=new Float32Array(256);
    this.reset(long,options);
  }
  reset(long=[],{standing=false,qpos=null,qvel=null}={}){
    this.mj.mj_resetData(this.model,this.data);this.data.qpos.set(qpos??(standing?this.engine.standing.qpos:this.config.initialQpos));if(qvel)this.data.qvel.set(qvel);else if(!standing)this.data.qvel.set(this.config.initialQvel);this.mj.mj_forward(this.model,this.data);
    this.long=[...long];this.short=[];this.pending=[];this.transition=null;this.first=true;this.history.fill(0);this.prev.fill(0);this.latents.fill(0);this.steps=0;this.contactCount=0;
  }
  dispose(){this.data.delete();this.kinData.delete();this.jp.delete();this.jr.delete();}
  keyBodies(joints,vel,gyro) {
    const {mj,kin:m,kinData:d,config:c}=this;
    d.qpos.fill(0);d.qpos[3]=1;d.qvel.fill(0);d.qvel.set(gyro,3);
    c.kinQposIds.forEach((id,i)=>{d.qpos[id]=joints[i];});c.kinQvelIds.forEach((id,i)=>{d.qvel[id]=vel[i];});mj.mj_forward(m,d);
    const cache=new Map();
    for(const id of new Set(c.keypoints.flatMap(s=>[s.body,s.correction]))) {
      mj.mj_jacBody(m,d,this.jp,this.jr,id);const jp=this.jp.GetView(),jr=this.jr.GetView();
      const lv=[0,0,0],av=[0,0,0];
      for(let r=0;r<3;r++)for(let j=0;j<m.nv;j++){lv[r]+=jp[r*m.nv+j]*d.qvel[j];av[r]+=jr[r*m.nv+j]*d.qvel[j];}
      cache.set(id,{p:Array.from(d.xpos.subarray(id*3,id*3+3),f),q:Array.from(d.xquat.subarray(id*4,id*4+4),f),lv:lv.map(f),av:av.map(f)});
    }
    const out=this.inputs.robot_key_body;
    c.keypoints.forEach((s,i)=>{
      const b=cache.get(s.body),bc=cache.get(s.correction),offset=rotate(b.q,s.offset.map(f)),correction=rotate(bc.q,s.correctionOffset.map(f));
      out.set(b.p.map((x,j)=>f(f(x+offset[j])+correction[j])),i*3);
      out.set(rot6(normalized(b.q)),39+i*6);
      const a=cross(b.av,offset),ac=cross(bc.av,correction);
      out.set(b.lv.map((x,j)=>f(f(x+a[j])+ac[j])),117+i*3);
      out.set(b.av.map((x,j)=>f(x-gyro[j])),156+i*3);
    });
  }

  observe(reference){
    const {data:d,config:c,inputs:o}=this;
    const joints=c.qposIds.map(id=>f(d.qpos[id])),vel=c.qvelIds.map(id=>f(d.qvel[id]));
    const q=normalized(Array.from(d.qpos.subarray(3,7),f)),gyro=Array.from(d.qvel.subarray(3,6),f),gravity=rotate(q,[0,0,-1],true);
    const parts=[joints.map((x,i)=>f(x-f(c.offset[i]))),vel,gravity,gyro,Array.from(this.prev),c.actuatorIds.map(id=>f(d.actuator_force[id]))];
    let offset=0;
    for(const part of parts){const n=part.length;if(this.first)for(let t=0;t<50;t++)this.history.set(part,offset+t*n);else{this.history.copyWithin(offset,offset+n,offset+50*n);this.history.set(part,offset+49*n);}offset+=50*n;}
    this.first=false;this.proprio=Float32Array.from(parts.flat());o.robot_root_quat.set(q);o.estimator_history.set(this.history);o.reference_encoder_input.set(reference);this.keyBodies(joints,vel,gyro);
    if(!this.memory){for(const key of ['robot_root_quat','estimator_history','robot_key_body'])if(!o[key].every(Number.isFinite))throw new Error('Nonfinite observation');return o;}
    if(this.transition){const interaction=new Float32Array(273);interaction.set(this.transition.before);interaction.set(this.transition.action,122);interaction.set(this.proprio,151);
      if(this.short.length===50){this.pending.push(this.short.shift());if(this.pending.length===10){this.long.push(Float32Array.from(this.pending.flatMap(a=>Array.from(a))));if(this.long.length>30)this.long.shift();this.pending=[];}}
      this.short.push(interaction);this.transition=null;
    }
    for(const key of ['short_interactions','short_valid','long_interactions','long_valid'])o[key].fill(0);
    this.short.forEach((x,i)=>{o.short_interactions.set(x,(50-this.short.length+i)*273);o.short_valid[50-this.short.length+i]=1;});
    this.long.forEach((x,i)=>{o.long_interactions.set(x,(30-this.long.length+i)*2730);o.long_valid[30-this.long.length+i]=1;});o.previous_latents.set(this.latents);
    for(const value of Object.values(o))if(!value.every(Number.isFinite))throw new Error('Nonfinite observation');
    return o;
  }
  calibratedLong(){
    const all=[...this.pending,...this.short],long=[...this.long];
    for(let i=0;i+10<=all.length;i+=10)long.push(Float32Array.from(all.slice(i,i+10).flatMap(a=>Array.from(a))));
    if(long.length<30)throw new Error('Incomplete calibration');return long.slice(-30);
  }
  advance(rawAction,latent=null,{warmup=false,record=true}={}){
    const {mj,model:m,data:d,config:c}=this;
    const action=Float32Array.from(rawAction,x=>this.label==='PRE'&&!warmup?Math.max(-10,Math.min(10,x)):x);
    if(!action.every(Number.isFinite)||action.length!==29)throw new Error('Invalid action');
    const desired=action.map((a,i)=>f(c.offset[i]+a*c.scale[i]));
    if(this.memory)this.transition={before:this.proprio.slice(),action:action.slice()};this.prev.set(action);
    if(latent){this.latents.copyWithin(0,64);this.latents.set(latent,192);}
    for(let s=0;s<c.substeps;s++){
      c.actuatorIds.forEach((id,i)=>{const torque=f(c.kp[i]*(desired[i]-d.qpos[c.qposIds[i]])+c.kd[i]*(0-d.qvel[c.qvelIds[i]]));d.ctrl[id]=Math.max(-c.effort[i],Math.min(c.effort[i],torque));});
      mj.mj_step(m,d);
    }
    if(!d.qpos.every(Number.isFinite)||!d.qvel.every(Number.isFinite))throw new Error('Simulation produced a nonfinite state');
    this.steps++;
    if(record)mj.mj_kinematics(m,d);
    const contacts=d.contact;
    for(let i=0;i<contacts.size();i++){const ct=contacts.get(i);if((ct.geom1===c.floor&&c.feet.includes(ct.geom2))||(ct.geom2===c.floor&&c.feet.includes(ct.geom1))){if(Math.abs(ct.friction[0]-this.engine.mu)>1e-12)throw new Error('Foot friction mismatch');this.contactCount++;}ct.delete();}contacts.delete();
    return action;
  }
  sample(frame){
    const c=this.config,actual=new Float32Array(42);
    c.bodyIds.forEach((id,i)=>actual.set(this.data.xpos.subarray(id*3,id*3+3),i*3));
    const reference=this.engine.refBodies.subarray(frame*42,(frame+1)*42);
    return {frame,time:frame*c.dt,...frameMetrics(actual,reference),qpos:Array.from(this.data.qpos),positions:Array.from(actual)};
  }
}
