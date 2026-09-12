You are given a task to integrate an existing React component in the codebase



The codebase should support:

\- shadcn project structure  

\- Tailwind CSS

\- Typescript



If it doesn't, provide instructions on how to setup project via shadcn CLI, install Tailwind or Typescript.



Determine the default path for components and styles. 

If default path for components is not /components/ui, provide instructions on why it's important to create this folder

Copy-paste this component to /components/ui folder:

```tsx

animated-shader-hero.tsx

import React, { useRef, useEffect, useState } from 'react';



// Types for component props

interface HeroProps {

&#x20; trustBadge?: {

&#x20;   text: string;

&#x20;   icons?: string\[];

&#x20; };

&#x20; headline: {

&#x20;   line1: string;

&#x20;   line2: string;

&#x20; };

&#x20; subtitle: string;

&#x20; buttons?: {

&#x20;   primary?: {

&#x20;     text: string;

&#x20;     onClick?: () => void;

&#x20;   };

&#x20;   secondary?: {

&#x20;     text: string;

&#x20;     onClick?: () => void;

&#x20;   };

&#x20; };

&#x20; className?: string;

}



// Reusable Shader Background Hook

const useShaderBackground = () => {

&#x20; const canvasRef = useRef<HTMLCanvasElement>(null);

&#x20; const animationFrameRef = useRef<number>();

&#x20; const rendererRef = useRef<WebGLRenderer | null>(null);

&#x20; const pointersRef = useRef<PointerHandler | null>(null);



&#x20; // WebGL Renderer class

&#x20; class WebGLRenderer {

&#x20;   private canvas: HTMLCanvasElement;

&#x20;   private gl: WebGL2RenderingContext;

&#x20;   private program: WebGLProgram | null = null;

&#x20;   private vs: WebGLShader | null = null;

&#x20;   private fs: WebGLShader | null = null;

&#x20;   private buffer: WebGLBuffer | null = null;

&#x20;   private scale: number;

&#x20;   private shaderSource: string;

&#x20;   private mouseMove = \[0, 0];

&#x20;   private mouseCoords = \[0, 0];

&#x20;   private pointerCoords = \[0, 0];

&#x20;   private nbrOfPointers = 0;



&#x20;   private vertexSrc = `#version 300 es

precision highp float;

in vec4 position;

void main(){gl\_Position=position;}`;



&#x20;   private vertices = \[-1, 1, -1, -1, 1, 1, 1, -1];



&#x20;   constructor(canvas: HTMLCanvasElement, scale: number) {

&#x20;     this.canvas = canvas;

&#x20;     this.scale = scale;

&#x20;     this.gl = canvas.getContext('webgl2')!;

&#x20;     this.gl.viewport(0, 0, canvas.width \* scale, canvas.height \* scale);

&#x20;     this.shaderSource = defaultShaderSource;

&#x20;   }



&#x20;   updateShader(source: string) {

&#x20;     this.reset();

&#x20;     this.shaderSource = source;

&#x20;     this.setup();

&#x20;     this.init();

&#x20;   }



&#x20;   updateMove(deltas: number\[]) {

&#x20;     this.mouseMove = deltas;

&#x20;   }



&#x20;   updateMouse(coords: number\[]) {

&#x20;     this.mouseCoords = coords;

&#x20;   }



&#x20;   updatePointerCoords(coords: number\[]) {

&#x20;     this.pointerCoords = coords;

&#x20;   }



&#x20;   updatePointerCount(nbr: number) {

&#x20;     this.nbrOfPointers = nbr;

&#x20;   }



&#x20;   updateScale(scale: number) {

&#x20;     this.scale = scale;

&#x20;     this.gl.viewport(0, 0, this.canvas.width \* scale, this.canvas.height \* scale);

&#x20;   }



&#x20;   compile(shader: WebGLShader, source: string) {

&#x20;     const gl = this.gl;

&#x20;     gl.shaderSource(shader, source);

&#x20;     gl.compileShader(shader);



&#x20;     if (!gl.getShaderParameter(shader, gl.COMPILE\_STATUS)) {

&#x20;       const error = gl.getShaderInfoLog(shader);

&#x20;       console.error('Shader compilation error:', error);

&#x20;     }

&#x20;   }



&#x20;   test(source: string) {

&#x20;     let result = null;

&#x20;     const gl = this.gl;

&#x20;     const shader = gl.createShader(gl.FRAGMENT\_SHADER)!;

&#x20;     gl.shaderSource(shader, source);

&#x20;     gl.compileShader(shader);



&#x20;     if (!gl.getShaderParameter(shader, gl.COMPILE\_STATUS)) {

&#x20;       result = gl.getShaderInfoLog(shader);

&#x20;     }

&#x20;     gl.deleteShader(shader);

&#x20;     return result;

&#x20;   }



&#x20;   reset() {

&#x20;     const gl = this.gl;

&#x20;     if (this.program \&\& !gl.getProgramParameter(this.program, gl.DELETE\_STATUS)) {

&#x20;       if (this.vs) {

&#x20;         gl.detachShader(this.program, this.vs);

&#x20;         gl.deleteShader(this.vs);

&#x20;       }

&#x20;       if (this.fs) {

&#x20;         gl.detachShader(this.program, this.fs);

&#x20;         gl.deleteShader(this.fs);

&#x20;       }

&#x20;       gl.deleteProgram(this.program);

&#x20;     }

&#x20;   }



&#x20;   setup() {

&#x20;     const gl = this.gl;

&#x20;     this.vs = gl.createShader(gl.VERTEX\_SHADER)!;

&#x20;     this.fs = gl.createShader(gl.FRAGMENT\_SHADER)!;

&#x20;     this.compile(this.vs, this.vertexSrc);

&#x20;     this.compile(this.fs, this.shaderSource);

&#x20;     this.program = gl.createProgram()!;

&#x20;     gl.attachShader(this.program, this.vs);

&#x20;     gl.attachShader(this.program, this.fs);

&#x20;     gl.linkProgram(this.program);



&#x20;     if (!gl.getProgramParameter(this.program, gl.LINK\_STATUS)) {

&#x20;       console.error(gl.getProgramInfoLog(this.program));

&#x20;     }

&#x20;   }



&#x20;   init() {

&#x20;     const gl = this.gl;

&#x20;     const program = this.program!;

&#x20;     

&#x20;     this.buffer = gl.createBuffer();

&#x20;     gl.bindBuffer(gl.ARRAY\_BUFFER, this.buffer);

&#x20;     gl.bufferData(gl.ARRAY\_BUFFER, new Float32Array(this.vertices), gl.STATIC\_DRAW);



&#x20;     const position = gl.getAttribLocation(program, 'position');

&#x20;     gl.enableVertexAttribArray(position);

&#x20;     gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);



&#x20;     (program as any).resolution = gl.getUniformLocation(program, 'resolution');

&#x20;     (program as any).time = gl.getUniformLocation(program, 'time');

&#x20;     (program as any).move = gl.getUniformLocation(program, 'move');

&#x20;     (program as any).touch = gl.getUniformLocation(program, 'touch');

&#x20;     (program as any).pointerCount = gl.getUniformLocation(program, 'pointerCount');

&#x20;     (program as any).pointers = gl.getUniformLocation(program, 'pointers');

&#x20;   }



&#x20;   render(now = 0) {

&#x20;     const gl = this.gl;

&#x20;     const program = this.program;

&#x20;     

&#x20;     if (!program || gl.getProgramParameter(program, gl.DELETE\_STATUS)) return;



&#x20;     gl.clearColor(0, 0, 0, 1);

&#x20;     gl.clear(gl.COLOR\_BUFFER\_BIT);

&#x20;     gl.useProgram(program);

&#x20;     gl.bindBuffer(gl.ARRAY\_BUFFER, this.buffer);

&#x20;     

&#x20;     gl.uniform2f((program as any).resolution, this.canvas.width, this.canvas.height);

&#x20;     gl.uniform1f((program as any).time, now \* 1e-3);

&#x20;     gl.uniform2f((program as any).move, ...this.mouseMove);

&#x20;     gl.uniform2f((program as any).touch, ...this.mouseCoords);

&#x20;     gl.uniform1i((program as any).pointerCount, this.nbrOfPointers);

&#x20;     gl.uniform2fv((program as any).pointers, this.pointerCoords);

&#x20;     gl.drawArrays(gl.TRIANGLE\_STRIP, 0, 4);

&#x20;   }

&#x20; }



&#x20; // Pointer Handler class

&#x20; class PointerHandler {

&#x20;   private scale: number;

&#x20;   private active = false;

&#x20;   private pointers = new Map<number, number\[]>();

&#x20;   private lastCoords = \[0, 0];

&#x20;   private moves = \[0, 0];



&#x20;   constructor(element: HTMLCanvasElement, scale: number) {

&#x20;     this.scale = scale;

&#x20;     

&#x20;     const map = (element: HTMLCanvasElement, scale: number, x: number, y: number) => 

&#x20;       \[x \* scale, element.height - y \* scale];



&#x20;     element.addEventListener('pointerdown', (e) => {

&#x20;       this.active = true;

&#x20;       this.pointers.set(e.pointerId, map(element, this.getScale(), e.clientX, e.clientY));

&#x20;     });



&#x20;     element.addEventListener('pointerup', (e) => {

&#x20;       if (this.count === 1) {

&#x20;         this.lastCoords = this.first;

&#x20;       }

&#x20;       this.pointers.delete(e.pointerId);

&#x20;       this.active = this.pointers.size > 0;

&#x20;     });



&#x20;     element.addEventListener('pointerleave', (e) => {

&#x20;       if (this.count === 1) {

&#x20;         this.lastCoords = this.first;

&#x20;       }

&#x20;       this.pointers.delete(e.pointerId);

&#x20;       this.active = this.pointers.size > 0;

&#x20;     });



&#x20;     element.addEventListener('pointermove', (e) => {

&#x20;       if (!this.active) return;

&#x20;       this.lastCoords = \[e.clientX, e.clientY];

&#x20;       this.pointers.set(e.pointerId, map(element, this.getScale(), e.clientX, e.clientY));

&#x20;       this.moves = \[this.moves\[0] + e.movementX, this.moves\[1] + e.movementY];

&#x20;     });

&#x20;   }



&#x20;   getScale() {

&#x20;     return this.scale;

&#x20;   }



&#x20;   updateScale(scale: number) {

&#x20;     this.scale = scale;

&#x20;   }



&#x20;   get count() {

&#x20;     return this.pointers.size;

&#x20;   }



&#x20;   get move() {

&#x20;     return this.moves;

&#x20;   }



&#x20;   get coords() {

&#x20;     return this.pointers.size > 0 

&#x20;       ? Array.from(this.pointers.values()).flat() 

&#x20;       : \[0, 0];

&#x20;   }



&#x20;   get first() {

&#x20;     return this.pointers.values().next().value || this.lastCoords;

&#x20;   }

&#x20; }



&#x20; const resize = () => {

&#x20;   if (!canvasRef.current) return;

&#x20;   

&#x20;   const canvas = canvasRef.current;

&#x20;   const dpr = Math.max(1, 0.5 \* window.devicePixelRatio);

&#x20;   

&#x20;   canvas.width = window.innerWidth \* dpr;

&#x20;   canvas.height = window.innerHeight \* dpr;

&#x20;   

&#x20;   if (rendererRef.current) {

&#x20;     rendererRef.current.updateScale(dpr);

&#x20;   }

&#x20; };



&#x20; const loop = (now: number) => {

&#x20;   if (!rendererRef.current || !pointersRef.current) return;

&#x20;   

&#x20;   rendererRef.current.updateMouse(pointersRef.current.first);

&#x20;   rendererRef.current.updatePointerCount(pointersRef.current.count);

&#x20;   rendererRef.current.updatePointerCoords(pointersRef.current.coords);

&#x20;   rendererRef.current.updateMove(pointersRef.current.move);

&#x20;   rendererRef.current.render(now);

&#x20;   animationFrameRef.current = requestAnimationFrame(loop);

&#x20; };



&#x20; useEffect(() => {

&#x20;   if (!canvasRef.current) return;



&#x20;   const canvas = canvasRef.current;

&#x20;   const dpr = Math.max(1, 0.5 \* window.devicePixelRatio);

&#x20;   

&#x20;   rendererRef.current = new WebGLRenderer(canvas, dpr);

&#x20;   pointersRef.current = new PointerHandler(canvas, dpr);

&#x20;   

&#x20;   rendererRef.current.setup();

&#x20;   rendererRef.current.init();

&#x20;   

&#x20;   resize();

&#x20;   

&#x20;   if (rendererRef.current.test(defaultShaderSource) === null) {

&#x20;     rendererRef.current.updateShader(defaultShaderSource);

&#x20;   }

&#x20;   

&#x20;   loop(0);

&#x20;   

&#x20;   window.addEventListener('resize', resize);

&#x20;   

&#x20;   return () => {

&#x20;     window.removeEventListener('resize', resize);

&#x20;     if (animationFrameRef.current) {

&#x20;       cancelAnimationFrame(animationFrameRef.current);

&#x20;     }

&#x20;     if (rendererRef.current) {

&#x20;       rendererRef.current.reset();

&#x20;     }

&#x20;   };

&#x20; }, \[]);



&#x20; return canvasRef;

};



// Reusable Hero Component

const Hero: React.FC<HeroProps> = ({

&#x20; trustBadge,

&#x20; headline,

&#x20; subtitle,

&#x20; buttons,

&#x20; className = ""

}) => {

&#x20; const canvasRef = useShaderBackground();



&#x20; return (

&#x20;   <div className={`relative w-full h-screen overflow-hidden bg-black ${className}`}>

&#x20;     <style jsx>{`

&#x20;       @keyframes fade-in-down {

&#x20;         from {

&#x20;           opacity: 0;

&#x20;           transform: translateY(-20px);

&#x20;         }

&#x20;         to {

&#x20;           opacity: 1;

&#x20;           transform: translateY(0);

&#x20;         }

&#x20;       }

&#x20;       

&#x20;       @keyframes fade-in-up {

&#x20;         from {

&#x20;           opacity: 0;

&#x20;           transform: translateY(30px);

&#x20;         }

&#x20;         to {

&#x20;           opacity: 1;

&#x20;           transform: translateY(0);

&#x20;         }

&#x20;       }

&#x20;       

&#x20;       .animate-fade-in-down {

&#x20;         animation: fade-in-down 0.8s ease-out forwards;

&#x20;       }

&#x20;       

&#x20;       .animate-fade-in-up {

&#x20;         animation: fade-in-up 0.8s ease-out forwards;

&#x20;         opacity: 0;

&#x20;       }

&#x20;       

&#x20;       .animation-delay-200 {

&#x20;         animation-delay: 0.2s;

&#x20;       }

&#x20;       

&#x20;       .animation-delay-400 {

&#x20;         animation-delay: 0.4s;

&#x20;       }

&#x20;       

&#x20;       .animation-delay-600 {

&#x20;         animation-delay: 0.6s;

&#x20;       }

&#x20;       

&#x20;       .animation-delay-800 {

&#x20;         animation-delay: 0.8s;

&#x20;       }

&#x20;       

&#x20;       @keyframes gradient-shift {

&#x20;         0% { background-position: 0% 50%; }

&#x20;         50% { background-position: 100% 50%; }

&#x20;         100% { background-position: 0% 50%; }

&#x20;       }

&#x20;       

&#x20;       .animate-gradient {

&#x20;         background-size: 200% 200%;

&#x20;         animation: gradient-shift 3s ease infinite;

&#x20;       }

&#x20;     `}</style>

&#x20;     

&#x20;     <canvas

&#x20;       ref={canvasRef}

&#x20;       className="absolute inset-0 w-full h-full object-contain touch-none"

&#x20;       style={{ background: 'black' }}

&#x20;     />

&#x20;     

&#x20;     {/\* Hero Content Overlay \*/}

&#x20;     <div className="absolute inset-0 z-10 flex flex-col items-center justify-center text-white">

&#x20;       {/\* Trust Badge \*/}

&#x20;       {trustBadge \&\& (

&#x20;         <div className="mb-8 animate-fade-in-down">

&#x20;           <div className="flex items-center gap-2 px-6 py-3 bg-orange-500/10 backdrop-blur-md border border-orange-300/30 rounded-full text-sm">

&#x20;             {trustBadge.icons \&\& (

&#x20;               <div className="flex">

&#x20;                 {trustBadge.icons.map((icon, index) => (

&#x20;                   <span key={index} className={`text-${index === 0 ? 'yellow' : index === 1 ? 'orange' : 'amber'}-300`}>

&#x20;                     {icon}

&#x20;                   </span>

&#x20;                 ))}

&#x20;               </div>

&#x20;             )}

&#x20;             <span className="text-orange-100">{trustBadge.text}</span>

&#x20;           </div>

&#x20;         </div>

&#x20;       )}



&#x20;       <div className="text-center space-y-6 max-w-5xl mx-auto px-4">

&#x20;         {/\* Main Heading with Animation \*/}

&#x20;         <div className="space-y-2">

&#x20;           <h1 className="text-5xl md:text-7xl lg:text-8xl font-bold bg-gradient-to-r from-orange-300 via-yellow-400 to-amber-300 bg-clip-text text-transparent animate-fade-in-up animation-delay-200">

&#x20;             {headline.line1}

&#x20;           </h1>

&#x20;           <h1 className="text-5xl md:text-7xl lg:text-8xl font-bold bg-gradient-to-r from-yellow-300 via-orange-400 to-red-400 bg-clip-text text-transparent animate-fade-in-up animation-delay-400">

&#x20;             {headline.line2}

&#x20;           </h1>

&#x20;         </div>

&#x20;         

&#x20;         {/\* Subtitle with Animation \*/}

&#x20;         <div className="max-w-3xl mx-auto animate-fade-in-up animation-delay-600">

&#x20;           <p className="text-lg md:text-xl lg:text-2xl text-orange-100/90 font-light leading-relaxed">

&#x20;             {subtitle}

&#x20;           </p>

&#x20;         </div>

&#x20;         

&#x20;         {/\* CTA Buttons with Animation \*/}

&#x20;         {buttons \&\& (

&#x20;           <div className="flex flex-col sm:flex-row gap-4 justify-center mt-10 animate-fade-in-up animation-delay-800">

&#x20;             {buttons.primary \&\& (

&#x20;               <button 

&#x20;                 onClick={buttons.primary.onClick}

&#x20;                 className="px-8 py-4 bg-gradient-to-r from-orange-500 to-yellow-500 hover:from-orange-600 hover:to-yellow-600 text-black rounded-full font-semibold text-lg transition-all duration-300 hover:scale-105 hover:shadow-xl hover:shadow-orange-500/25"

&#x20;               >

&#x20;                 {buttons.primary.text}

&#x20;               </button>

&#x20;             )}

&#x20;             {buttons.secondary \&\& (

&#x20;               <button 

&#x20;                 onClick={buttons.secondary.onClick}

&#x20;                 className="px-8 py-4 bg-orange-500/10 hover:bg-orange-500/20 border border-orange-300/30 hover:border-orange-300/50 text-orange-100 rounded-full font-semibold text-lg transition-all duration-300 hover:scale-105 backdrop-blur-sm"

&#x20;               >

&#x20;                 {buttons.secondary.text}

&#x20;               </button>

&#x20;             )}

&#x20;           </div>

&#x20;         )}

&#x20;       </div>

&#x20;     </div>

&#x20;   </div>

&#x20; );

};



const defaultShaderSource = `#version 300 es

/\*\*\*\*\*\*\*\*\*

\* made by Matthias Hurrle (@atzedent)

\*

\*	To explore strange new worlds, to seek out new life

\*	and new civilizations, to boldly go where no man has

\*	gone before.

\*/

precision highp float;

out vec4 O;

uniform vec2 resolution;

uniform float time;

\#define FC gl\_FragCoord.xy

\#define T time

\#define R resolution

\#define MN min(R.x,R.y)

// Returns a pseudo random number for a given point (white noise)

float rnd(vec2 p) {

&#x20; p=fract(p\*vec2(12.9898,78.233));

&#x20; p+=dot(p,p+34.56);

&#x20; return fract(p.x\*p.y);

}

// Returns a pseudo random number for a given point (value noise)

float noise(in vec2 p) {

&#x20; vec2 i=floor(p), f=fract(p), u=f\*f\*(3.-2.\*f);

&#x20; float

&#x20; a=rnd(i),

&#x20; b=rnd(i+vec2(1,0)),

&#x20; c=rnd(i+vec2(0,1)),

&#x20; d=rnd(i+1.);

&#x20; return mix(mix(a,b,u.x),mix(c,d,u.x),u.y);

}

// Returns a pseudo random number for a given point (fractal noise)

float fbm(vec2 p) {

&#x20; float t=.0, a=1.; mat2 m=mat2(1.,-.5,.2,1.2);

&#x20; for (int i=0; i<5; i++) {

&#x20;   t+=a\*noise(p);

&#x20;   p\*=2.\*m;

&#x20;   a\*=.5;

&#x20; }

&#x20; return t;

}

float clouds(vec2 p) {

&#x09;float d=1., t=.0;

&#x09;for (float i=.0; i<3.; i++) {

&#x09;	float a=d\*fbm(i\*10.+p.x\*.2+.2\*(1.+i)\*p.y+d+i\*i+p);

&#x09;	t=mix(t,d,a);

&#x09;	d=a;

&#x09;	p\*=2./(i+1.);

&#x09;}

&#x09;return t;

}

void main(void) {

&#x09;vec2 uv=(FC-.5\*R)/MN,st=uv\*vec2(2,1);

&#x09;vec3 col=vec3(0);

&#x09;float bg=clouds(vec2(st.x+T\*.5,-st.y));

&#x09;uv\*=1.-.3\*(sin(T\*.2)\*.5+.5);

&#x09;for (float i=1.; i<12.; i++) {

&#x09;	uv+=.1\*cos(i\*vec2(.1+.01\*i, .8)+i\*i+T\*.5+.1\*uv.x);

&#x09;	vec2 p=uv;

&#x09;	float d=length(p);

&#x09;	col+=.00125/d\*(cos(sin(i)\*vec3(1,2,3))+1.);

&#x09;	float b=noise(i+p+bg\*1.731);

&#x09;	col+=.002\*b/length(max(p,vec2(b\*p.x\*.02,p.y)));

&#x09;	col=mix(col,vec3(bg\*.25,bg\*.137,bg\*.05),d);

&#x09;}

&#x09;O=vec4(col,1);

}`;



export default Hero;



demo.tsx

import Hero from "@/components/ui/animated-shader-hero";



// Demo Component showing how to use the Hero

const HeroDemo: React.FC = () => {

&#x20; const handlePrimaryClick = () => {

&#x20;   console.log('Get Started clicked!');

&#x20;   // Add your logic here

&#x20; };



&#x20; const handleSecondaryClick = () => {

&#x20;   console.log('Explore Features clicked!');

&#x20;   // Add your logic here

&#x20; };



&#x20; return (

&#x20;   <div className="w-full">

&#x20;     <Hero

&#x20;       trustBadge={{

&#x20;         text: "Trusted by forward-thinking teams.",

&#x20;         icons: \["✨"]

&#x20;       }}

&#x20;       headline={{

&#x20;         line1: "Launch Your",

&#x20;         line2: "Workflow Into Orbit"

&#x20;       }}

&#x20;       subtitle="Supercharge productivity with AI-powered automation and integrations built for the next generation of teams — fast, seamless, and limitless."

&#x20;       buttons={{

&#x20;         primary: {

&#x20;           text: "Get Started for Free",

&#x20;           onClick: handlePrimaryClick

&#x20;         },

&#x20;         secondary: {

&#x20;           text: "Explore Features",

&#x20;           onClick: handleSecondaryClick

&#x20;         }

&#x20;       }}

&#x20;     />

&#x20;     

&#x20;     {/\* Additional content below hero \*/}

&#x20;     <div className="bg-gray-100 p-8">

&#x20;       <div className="max-w-4xl mx-auto">

&#x20;         <h2 className="text-3xl font-bold text-gray-800 mb-4">

&#x20;           How to Use the Hero Component

&#x20;         </h2>

&#x20;         <div className="bg-white p-6 rounded-lg shadow-sm">

&#x20;           <pre className="text-sm text-gray-600 overflow-x-auto">

{`<Hero

&#x20; trustBadge={{

&#x20;   text: "Your trust badge text",

&#x20;   icons: \["🚀", "⭐", "✨"] // optional

&#x20; }}

&#x20; headline={{

&#x20;   line1: "Your First Line",

&#x20;   line2: "Your Second Line"

&#x20; }}

&#x20; subtitle="Your compelling subtitle text goes here..."

&#x20; buttons={{

&#x20;   primary: {

&#x20;     text: "Primary CTA",

&#x20;     onClick: handlePrimaryClick

&#x20;   },

&#x20;   secondary: {

&#x20;     text: "Secondary CTA", 

&#x20;     onClick: handleSecondaryClick

&#x20;   }

&#x20; }}

&#x20; className="custom-classes" // optional

/>`}

&#x20;           </pre>

&#x20;         </div>

&#x20;       </div>

&#x20;     </div>

&#x20;   </div>

&#x20; );

};



export default HeroDemo;

```



