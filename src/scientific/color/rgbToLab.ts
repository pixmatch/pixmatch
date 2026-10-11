import type { Lab, RGB, XYZ } from '../types';
const D65: XYZ = [0.95047, 1, 1.08883];
export function rgbToXyz(rgb: RGB): XYZ {
  const c = rgb.map(v => Math.max(0, Math.min(255, v)) / 255).map(v => v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  const [r,g,b] = c;
  return [r*0.4124564+g*0.3575761+b*0.1804375, r*0.2126729+g*0.7151522+b*0.0721750, r*0.0193339+g*0.1191920+b*0.9503041];
}
function f(t:number){ const d=6/29; return t>d**3 ? Math.cbrt(t) : t/(3*d*d)+4/29; }
export function xyzToLab([x,y,z]:XYZ):Lab { return [116*f(y/D65[1])-16, 500*(f(x/D65[0])-f(y/D65[1])), 200*(f(y/D65[1])-f(z/D65[2]))]; }
export function rgbToLab(rgb:RGB):Lab { return xyzToLab(rgbToXyz(rgb)); }
export function imageToLab(frame:{width:number;height:number;data:Uint8ClampedArray}):Float32Array { const out=new Float32Array(frame.width*frame.height*3); for(let i=0,p=0;i<frame.data.length;i+=4,p+=3){ const l=rgbToLab([frame.data[i],frame.data[i+1],frame.data[i+2]]); out[p]=l[0];out[p+1]=l[1];out[p+2]=l[2]; } return out; }
