
'use strict';

/**
 * Module dependencies.
 */
//判断当前传入的函数是不是一个GeneratorFunction
const isGeneratorFunction = require('is-generator-function');
//调试工具
const debug = require('debug')('koa:application');
//事件监听当一个http请求关闭完成出错的时候调用写好的回调函数
const onFinished = require('on-finished');
//响应请求返回数据
const response = require('./response');
//中间件的函数数组 koa中的所有中间件必须是中间件数组 数组里面的每一个值都必须是函数
const compose = require('koa-compose');
//判断数据是不是json数据
const isJSON = require('koa-is-json');
//http的上下文
const context = require('./context');
//客户端的请求以及携带的数据
const request = require('./request');
//请求的状态码
const statuses = require('statuses');
//业务信息 业务埋点
const Cookies = require('cookies');
//那些数据可以被服务器接收协议及资源的控制
const accepts = require('accepts');
//事件循环
const Emitter = require('events');
//断言 判断一个代码的结果是否符合预期
const assert = require('assert');
//流
const Stream = require('stream');
//针对http协议封装的上层web服务接口
const http = require('http');
//把对象的某些key 剪出来
const only = require('only');
//针对老版本koa做兼容
const convert = require('koa-convert');
//判断暴露的接口方法是不是过期了 
const deprecate = require('depd')('koa');

/**
 * Expose `Application` class.
 * Inherits from `Emitter.prototype`.
 */

module.exports = class Application extends Emitter {
  /**
   * Initialize a new `Application`.
   *
   * @api public
   */
  //定义属性
  constructor() {
    super();

    this.proxy = false;
    this.middleware = [];
    this.subdomainOffset = 2;
    this.env = process.env.NODE_ENV || 'development';
    this.context = Object.create(context);
    this.request = Object.create(request);
    this.response = Object.create(response);
  }

  /**
   * Shorthand for:
   *
   *    http.createServer(app.callback()).listen(...)
   *
   * @param {Mixed} ...
   * @return {Server}
   * @api public
   */

  listen(...args) {
    debug('listen');
    //通过node的http模块生成一个服务器实例 然后看下面对应的这个callback方法
    const server = http.createServer(this.callback());
    //然后让这个实例去listen在传入参数
    return server.listen(...args);
  }

  /**
   * Return JSON representation.
   * We only bother showing settings.
   *
   * @return {Object}
   * @api public
   */

  toJSON() {
    return only(this, [
      'subdomainOffset',
      'proxy',
      'env'
    ]);
  }

  /**
   * Inspect implementation.
   *
   * @return {Object}
   * @api public
   */

  inspect() {
    return this.toJSON();
  }

  /**
   * Use the given middleware `fn`.
   *
   * Old-style middleware will be converted.
   *
   * @param {Function} fn
   * @return {Application} self
   * @api public
   */

  use(fn) {
    //判断传过来的函数是不是一个函数
    if (typeof fn !== 'function') throw new TypeError('middleware must be a function!');
    //兼容操作
    if (isGeneratorFunction(fn)) {
      deprecate('Support for generators will be removed in v3. ' +
                'See the documentation for examples of how to convert old middleware ' +
                'https://github.com/koajs/koa/blob/master/docs/migration.md');
      fn = convert(fn);
    }
    //调试
    debug('use %s', fn._name || fn.name || '-');
    //将传过来的函数添加到上面定义的中间件中
    this.middleware.push(fn);
    return this;
  }

  /**
   * Return a request handler callback
   * for node's native http server.
   *
   * @return {Function}
   * @api public
   */

   
  callback() {
    //通过compose处理中间件数组
    const fn = compose(this.middleware);

    if (!this.listeners('error').length) this.on('error', this.onerror);
    //将当前的req res生成一个上下文
    const handleRequest = (req, res) => {
      const ctx = this.createContext(req, res);
      //传上下文和中间件数组 接着往下看handleRequest方法
      return this.handleRequest(ctx, fn);
    };

    return handleRequest;
  }

  /**
   * Handle request in callback.
   *
   * @api private
   */

  handleRequest(ctx, fnMiddleware) {
    //通过上下文拿到 res
    const res = ctx.res;
    //设置默认的404状态
    res.statusCode = 404;
    const onerror = err => ctx.onerror(err);
    //res返回数据 继续看respond方法
    const handleResponse = () => respond(ctx);
    onFinished(res, onerror);
    //先把请求的上下文给中间件数组去做对应的事情 把结果给handleResponse
    return fnMiddleware(ctx).then(handleResponse).catch(onerror);
  }

  /**
   * Initialize a new context.
   *
   * @api private
   */
  //一些上下文的东西用来调用
  createContext(req, res) {
    //将context.js挂载的那些给新的context
    const context = Object.create(this.context);
    const request = context.request = Object.create(this.request);
    const response = context.response = Object.create(this.response);
    //以下都是将一些属性给上下文或者是req res方便调用
    context.app = request.app = response.app = this;
    context.req = request.req = response.req = req;
    context.res = request.res = response.res = res;
    request.ctx = response.ctx = context;
    request.response = response;
    response.request = request;
    context.originalUrl = request.originalUrl = req.url;
    context.cookies = new Cookies(req, res, {
      keys: this.keys,
      secure: request.secure
    });
    request.ip = request.ips[0] || req.socket.remoteAddress || '';
    context.accept = request.accept = accepts(req);
    context.state = {};
    return context;
  }

  /**
   * Default error handler.
   *
   * @param {Error} err
   * @api private
   */

   //异常情况处理
  onerror(err) {
    assert(err instanceof Error, `non-error thrown: ${err}`);

    if (404 == err.status || err.expose) return;
    if (this.silent) return;

    const msg = err.stack || err.toString();
    console.error();
    console.error(msg.replace(/^/gm, '  '));
    console.error();
  }
};

/**
 * Response helper.
 */
 //对上下文的一些检验
function respond(ctx) {
  // allow bypassing koa
  if (false === ctx.respond) return;

  const res = ctx.res;
  if (!ctx.writable) return;

  let body = ctx.body;
  const code = ctx.status;

  // ignore body
  if (statuses.empty[code]) {
    // strip headers
    ctx.body = null;
    return res.end();
  }

  if ('HEAD' == ctx.method) {
    if (!res.headersSent && isJSON(body)) {
      ctx.length = Buffer.byteLength(JSON.stringify(body));
    }
    return res.end();
  }

  // status body
  if (null == body) {
    body = ctx.message || String(code);
    if (!res.headersSent) {
      ctx.type = 'text';
      ctx.length = Buffer.byteLength(body);
    }
    return res.end(body);
  }

  // responses
  //向客户端返回数据
  if (Buffer.isBuffer(body)) return res.end(body);
  if ('string' == typeof body) return res.end(body);
  if (body instanceof Stream) return body.pipe(res);

  // body: json
  body = JSON.stringify(body);
  if (!res.headersSent) {
    ctx.length = Buffer.byteLength(body);
  }
  res.end(body);
}
