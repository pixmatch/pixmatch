import type { PhaseMask } from '../types';
export function area(mask:PhaseMask){let n=0;for(const v of mask.data)n+=v?1:0;return n;}
export function boundaryContinuity(mask:PhaseMask):number{let boundary=0,continuous=0;for(let y=0;y<mask.height;y++)for(let x=0;x<mask.width;x++)if(mask.data[y*mask.width+x]){let n=0;for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++)if(dx||dy){const xx=x+dx,yy=y+dy;if(xx>=0&&yy>=0&&xx<mask.width&&yy<mask.height&&mask.data[yy*mask.width+xx])n++;}boundary++;if(n>=2)continuous++;}return boundary?continuous/boundary:0;}
