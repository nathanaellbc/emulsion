/**
 * Minimal WebGL2 plumbing: program compilation, float render targets, and the
 * single fullscreen triangle every pass in this pipeline draws.
 */

export class GLError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GLError';
  }
}

export interface Target {
  fbo: WebGLFramebuffer;
  texture: WebGLTexture;
  width: number;
  height: number;
  internalFormat: number;
}

const VERT_FULLSCREEN = `#version 300 es
// One oversized triangle: no vertex buffer, no index buffer, no clipping seam.
out vec2 vUv;
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

export function createContext(canvas: HTMLCanvasElement): WebGL2RenderingContext {
  const gl = canvas.getContext('webgl2', {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    premultipliedAlpha: false,
    preserveDrawingBuffer: true,
    powerPreference: 'high-performance',
  });
  if (!gl) {
    throw new GLError(
      'This browser has no WebGL2. EMULSION evaluates the film chain on the GPU and cannot run without it.',
    );
  }
  if (!gl.getExtension('EXT_color_buffer_float')) {
    throw new GLError(
      'This GPU cannot render to floating-point textures (EXT_color_buffer_float). The chain works in scene-referred density and needs more than 8 bits per channel.',
    );
  }
  // Not fatal: without it the blur passes fall back to nearest sampling.
  gl.getExtension('OES_texture_float_linear');
  return gl;
}

function compile(gl: WebGL2RenderingContext, type: number, source: string, label: string) {
  const shader = gl.createShader(type);
  if (!shader) throw new GLError(`could not create shader for ${label}`);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? '';
    gl.deleteShader(shader);
    throw new GLError(`${label} failed to compile:\n${log}`);
  }
  return shader;
}

export class Program {
  readonly program: WebGLProgram;
  private readonly locations = new Map<string, WebGLUniformLocation | null>();

  constructor(
    private readonly gl: WebGL2RenderingContext,
    fragmentSource: string,
    readonly label: string,
  ) {
    const vs = compile(gl, gl.VERTEX_SHADER, VERT_FULLSCREEN, `${label} (vertex)`);
    const fs = compile(gl, gl.FRAGMENT_SHADER, fragmentSource, `${label} (fragment)`);
    const program = gl.createProgram();
    if (!program) throw new GLError(`could not create program ${label}`);
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program) ?? '';
      gl.deleteProgram(program);
      throw new GLError(`${label} failed to link:\n${log}`);
    }
    this.program = program;
  }

  use() {
    this.gl.useProgram(this.program);
    return this;
  }

  private loc(name: string) {
    let l = this.locations.get(name);
    if (l === undefined) {
      l = this.gl.getUniformLocation(this.program, name);
      this.locations.set(name, l);
    }
    return l;
  }

  int(name: string, v: number) {
    const l = this.loc(name);
    if (l) this.gl.uniform1i(l, v);
    return this;
  }

  uint(name: string, v: number) {
    const l = this.loc(name);
    if (l) this.gl.uniform1ui(l, v >>> 0);
    return this;
  }

  float(name: string, v: number) {
    const l = this.loc(name);
    if (l) this.gl.uniform1f(l, v);
    return this;
  }

  vec2(name: string, x: number, y: number) {
    const l = this.loc(name);
    if (l) this.gl.uniform2f(l, x, y);
    return this;
  }

  vec3(name: string, v: ArrayLike<number>) {
    const l = this.loc(name);
    if (l) this.gl.uniform3fv(l, v as Float32List);
    return this;
  }

  vec3Array(name: string, v: Float32Array) {
    const l = this.loc(name);
    if (l) this.gl.uniform3fv(l, v);
    return this;
  }

  mat3(name: string, v: Float32Array) {
    const l = this.loc(name);
    if (l) this.gl.uniformMatrix3fv(l, false, v);
    return this;
  }

  texture(name: string, unit: number, tex: WebGLTexture) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    this.int(name, unit);
    return this;
  }

  dispose() {
    this.gl.deleteProgram(this.program);
  }
}

export function createTarget(
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
  internalFormat: number = gl.RGBA16F,
  filter: number = gl.LINEAR,
): Target {
  const texture = gl.createTexture();
  if (!texture) throw new GLError('could not allocate texture');
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texStorage2D(gl.TEXTURE_2D, 1, internalFormat, Math.max(width, 1), Math.max(height, 1));
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  const fbo = gl.createFramebuffer();
  if (!fbo) throw new GLError('could not allocate framebuffer');
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  if (status !== gl.FRAMEBUFFER_COMPLETE) {
    throw new GLError(`framebuffer incomplete (0x${status.toString(16)}) at ${width}x${height}`);
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { fbo, texture, width, height, internalFormat };
}

export function disposeTarget(gl: WebGL2RenderingContext, t: Target) {
  gl.deleteFramebuffer(t.fbo);
  gl.deleteTexture(t.texture);
}

export function bindTarget(gl: WebGL2RenderingContext, t: Target | null, canvasSize?: [number, number]) {
  if (t) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
    gl.viewport(0, 0, t.width, t.height);
  } else {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvasSize?.[0] ?? gl.drawingBufferWidth, canvasSize?.[1] ?? gl.drawingBufferHeight);
  }
}

export function drawFullscreen(gl: WebGL2RenderingContext) {
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}
