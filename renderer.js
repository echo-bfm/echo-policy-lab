import * as THREE from 'three';
import {OrbitControls} from './vendor/OrbitControls.js';

export const colors=['#b86c30','#0071e3','#8b66c1','#50858c'];
export function policyName(label){return label==='PRE'?'ECHO-PRE':label==='N'?'ECHO-N':`ECHO-N ← ${Number(label.slice(2)).toFixed(1)}`;}
export class Viewer {
  constructor(container,panels){
    this.container=container;this.panels=panels;this.lanes=[];this.poses=[];this.ghost=true;this.dirty=true;
    this.camera=new THREE.PerspectiveCamera(36,1,.01,100);this.camera.up.set(0,0,1);
    const canvas=document.createElement('canvas');let gl;
    try{gl=new URLSearchParams(location.search).get('view')==='2d'?null:canvas.getContext('webgl2',{antialias:true});}catch{}
    if(gl){this.gl=gl;const debug=gl.getExtension('WEBGL_debug_renderer_info');this.gpu=debug?gl.getParameter(debug.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER);this.renderer=new THREE.WebGLRenderer({canvas,context:gl});this.renderer.setPixelRatio(Math.min(devicePixelRatio,1.5));this.renderer.setScissorTest(true);this.renderer.outputColorSpace=THREE.SRGBColorSpace;this.renderer.toneMapping=THREE.ACESFilmicToneMapping;this.renderer.toneMappingExposure=1.25;}
    else {this.canvas=canvas;this.ctx=canvas.getContext('2d');}
    this.softwareRendering=/swiftshader|llvmpipe|softpipe|software/i.test(this.gpu??'');
    this.frameInterval=this.softwareRendering?250:16;
    if(this.softwareRendering)this.renderer.setPixelRatio(1);
    container.append(canvas);this.controls=new OrbitControls(this.camera,container.parentElement);this.controls.enableDamping=true;this.controls.minDistance=1.4;this.controls.maxDistance=15;this.controls.maxPolarAngle=Math.PI*.49;this.controls.addEventListener('change',()=>this.dirty=true);
    new ResizeObserver(()=>this.resize()).observe(container);this.resize();
    // Leave the UI time to process controls when full meshes use software GL.
    // Only rendering is paced; the worker still executes every physics step.
    let nextDraw=0;
    const animate=()=>{this.controls.update();const now=performance.now();if(this.dirty&&now>=nextDraw){const begin=performance.now();this.draw();this.drawMs=performance.now()-begin;nextDraw=performance.now()+Math.max(this.frameInterval,Math.min(1000,this.drawMs));}this.animation=requestAnimationFrame(animate);};animate();
  }
  async model(model,{yieldBatches=false}={}){
    // Yield between batches so controls and loading progress can paint.
    this.geometries=[];let batchStart=performance.now();
    for(const g of model.geoms){const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.BufferAttribute(g.vertices,3));geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(g.faces),1));geometry.computeVertexNormals();this.geometries.push(geometry);if(yieldBatches&&performance.now()-batchStart>12){await new Promise(resolve=>setTimeout(resolve,0));batchStart=performance.now();}}
    this.data=model;
    const root=model.initial.bodyPos.subarray(3,6);this.referenceXY=[root[0],root[1]];this.camera.position.set(root[0]+2.4,root[1]-3.5,2.1);this.controls.target.set(root[0],root[1],.85);this.controls.update();this.dirty=true;
  }
  setup(labels){
    this.labels=labels;this.panels.classList.toggle('four',labels.length===4);
    this.panels.style.gridTemplateColumns=labels.length===4&&innerWidth>1050?'repeat(4,minmax(0,1fr))':'repeat(2,minmax(0,1fr))';
    this.panels.innerHTML=labels.map((label,i)=>`<div class="lane" style="--color:${colors[i]}"><div class="lane-name"><i></i>${policyName(label)}</div><div class="lane-protocol">${label==='PRE'?'Frozen tracker':label==='N'?'Own online history':'Continuous donor history'}</div><div class="lane-stat">—<small>mm</small></div><div class="lane-state">Ready</div></div>`).join('');
    this.lanes.forEach(l=>l.materials.forEach(m=>m.dispose()));this.lanes=[];this.poses=labels.map(()=>this.data?.initial);
    if(!this.data)return;
    for(let i=0;i<labels.length;i++){
      const scene=new THREE.Scene();scene.background=new THREE.Color('#f5f5f7');scene.fog=new THREE.Fog('#f5f5f7',9,25);
      scene.add(new THREE.HemisphereLight('#ffffff','#b0b3bd',2.2));const light=new THREE.DirectionalLight('#ffffff',2.5);light.position.set(3,-4,7);scene.add(light);const rim=new THREE.DirectionalLight('#dce8ff',1.3);rim.position.set(-4,2,4);scene.add(rim);
      const groundMaterial=new THREE.MeshStandardMaterial({color:'#eeeff2',roughness:1});const ground=new THREE.Mesh(new THREE.PlaneGeometry(50,50),groundMaterial);ground.position.z=-.006;scene.add(ground);
      const grid=new THREE.GridHelper(50,100,'#d1d3da','#dedee5');grid.rotation.x=Math.PI/2;grid.position.z=-.004;scene.add(grid);
      const material=new THREE.MeshStandardMaterial({color:colors[i],roughness:.65,metalness:.08});const ghostMaterial=new THREE.MeshBasicMaterial({color:colors[i],transparent:true,opacity:.15,depthWrite:false});
      const robot=[],ghost=[];
      this.data.geoms.forEach((g,j)=>{
        for(const [list,mat] of [[robot,material],[ghost,ghostMaterial]]){const group=new THREE.Group(),mesh=new THREE.Mesh(this.geometries[j],mat);mesh.position.fromArray(g.pos);mesh.quaternion.set(g.quat[1],g.quat[2],g.quat[3],g.quat[0]);group.add(mesh);scene.add(group);list.push({group,body:g.body});}
      });
      this.lanes.push({scene,robot,ghost,materials:[material,ghostMaterial,groundMaterial,grid.material]});
    }
    this.resize();
  }
  resize(){
    this.dirty=true;
    const w=this.container.clientWidth,h=this.container.clientHeight;
    if(this.renderer)this.renderer.setSize(w,h);else{this.canvas.width=w*devicePixelRatio;this.canvas.height=h*devicePixelRatio;this.ctx.setTransform(devicePixelRatio,0,0,devicePixelRatio,0,0);}
    if(this.labels?.length===4)this.panels.style.gridTemplateColumns=innerWidth>1050?'repeat(4,minmax(0,1fr))':'repeat(2,minmax(0,1fr))';
  }
  translateView(x,y){this.camera.position.x+=x;this.camera.position.y+=y;this.controls.target.x+=x;this.controls.target.y+=y;this.dirty=true;}
  centerReference(){if(this.referenceXY)this.translateView(this.referenceXY[0]-this.controls.target.x,this.referenceXY[1]-this.controls.target.y);}
  setFollow(enabled){this.followReference=enabled;if(enabled)this.centerReference();}
  fit(){
    if(!this.poses.length)return;const id=this.data.bodyIds[0],points=this.poses.flatMap(p=>p?[p.bodyPos,p.ghostPos].map(a=>[a[id*3],a[id*3+1]]):[]).filter(a=>a.every(Number.isFinite));if(!points.length)return;
    const min=[0,1].map(i=>Math.min(...points.map(p=>p[i]))),max=[0,1].map(i=>Math.max(...points.map(p=>p[i]))),direction=this.camera.position.clone().sub(this.controls.target).normalize();
    this.controls.target.set((min[0]+max[0])/2,(min[1]+max[1])/2,.75);
    const aspect=Math.max(.4,this.panels.children[0].clientWidth/this.panels.children[0].clientHeight),radius=Math.hypot(max[0]-min[0],max[1]-min[1])/2+.85;
    const distance=Math.max(4.4,radius/Math.tan(THREE.MathUtils.degToRad(18))/Math.min(1,aspect));
    this.controls.maxDistance=Math.max(15,distance*1.2);this.camera.far=Math.max(100,distance*3);
    this.lanes.forEach(l=>{l.scene.fog.near=Math.max(9,distance*1.6);l.scene.fog.far=Math.max(25,distance*4);});
    this.camera.position.copy(this.controls.target).addScaledVector(direction,distance);this.controls.update();this.dirty=true;
  }
  update(poses){
    const id=this.data?.bodyIds[0],p=poses[0]?.ghostPos;
    if(p&&Number.isFinite(p[id*3])&&Number.isFinite(p[id*3+1])){const xy=[p[id*3],p[id*3+1]];if(this.followReference&&this.referenceXY)this.translateView(xy[0]-this.referenceXY[0],xy[1]-this.referenceXY[1]);this.referenceXY=xy;}
    this.poses=poses;this.dirty=true;
  }
  draw(){
    if(!this.data||!this.dirty)return;this.dirty=false;
    const bounds=this.container.getBoundingClientRect(),cells=[...this.panels.children];
    if(this.ctx){this.ctx.fillStyle='#f5f5f7';this.ctx.fillRect(0,0,bounds.width,bounds.height);}
    this.lanes.forEach((lane,i)=>{
      const r=cells[i]?.getBoundingClientRect(),pose=this.poses[i];if(!r||!pose)return;
      const x=r.left-bounds.left,y=r.top-bounds.top;this.camera.aspect=r.width/r.height;this.camera.updateProjectionMatrix();this.camera.updateMatrixWorld();
      if(this.renderer){
        for(const [list,pos,quat,isGhost] of [[lane.robot,pose.bodyPos,pose.bodyQuat,false],[lane.ghost,pose.ghostPos,pose.ghostQuat,true]])for(const {group,body} of list){group.visible=(!isGhost||this.ghost)&&Number.isFinite(pos?.[body*3]);if(group.visible){group.position.fromArray(pos,body*3);group.quaternion.set(quat[body*4+1],quat[body*4+2],quat[body*4+3],quat[body*4]);}}
        // Restore clipping for every pane: renderer/context state can reset
        // after initialization, and an unclipped clear erases earlier panes.
        this.renderer.setScissorTest(true);this.renderer.setViewport(x,bounds.height-y-r.height,r.width,r.height);this.renderer.setScissor(x,bounds.height-y-r.height,r.width,r.height);this.renderer.render(lane.scene,this.camera);
      }else{
        const ctx=this.ctx;ctx.save();ctx.beginPath();ctx.rect(x,y,r.width,r.height);ctx.clip();
        const project=(a)=>{const v=new THREE.Vector3(...a).project(this.camera);return [x+(v.x+1)*r.width/2,y+(1-v.y)*r.height/2];};
        const line=(a,b,color,width)=>{ctx.strokeStyle=color;ctx.lineWidth=width;ctx.beginPath();ctx.moveTo(...project(a));ctx.lineTo(...project(b));ctx.stroke();};
        const root=this.controls.target;for(let k=-8;k<=8;k++){line([root.x-4,root.y+k*.5,0],[root.x+4,root.y+k*.5,0],'#d2d2da',.7);line([root.x+k*.5,root.y-4,0],[root.x+k*.5,root.y+4,0],'#d2d2da',.7);}
        for(const [pos,color] of [[this.ghost?pose.ghostPos:null,colors[i]+'55'],[pose.bodyPos,colors[i]]])if(pos){for(let id=1;id<this.data.bodyParents.length;id++){const parent=this.data.bodyParents[id];if(parent&&Number.isFinite(pos[id*3])&&Number.isFinite(pos[parent*3]))line(Array.from(pos.slice(id*3,id*3+3)),Array.from(pos.slice(parent*3,parent*3+3)),color,4);}}
        ctx.restore();
      }
    });
  }
}
