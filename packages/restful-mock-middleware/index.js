// .mock.config.js 结构 module.exports = function(moacApp){}
// mockApp 只提供了 get、post、patch、put、delete、all，6个 api
// 用法跟 express app 一致（没有 next）
// res.send、res.json、res.jsonp 三种方式都支持 mock.js 语法。
'use strict';

const fs = require('fs-extra');
const path = require('path');
const bodyParser = require('body-parser');
const multer = require('multer');
const mockjs = require('mockjs');
const _ = require('lodash');
const chalk = require('chalk');
const pathToRegexp = require('path-to-regexp');
const composeMiddlewares = require('webpack-launcher-utils/expressMiddlewareCompose');

let mockFolder = path.resolve('./mock');
// 文件上传的位置
let uploadDest = path.resolve(mockFolder, './uploads');
let mockConfigFile = path.resolve(mockFolder, '.mock.config.js');
let mockConfigFormatter = function(mockConfig) {
  return mockConfig;
};

/**
 * 创建 express mock middleware
 * @param {Object} options
 * @param {String} options.mockFolder mock 文件的存储位置，所有的 mock 文件统一放在这个文件夹下
 * @param {Object} options.uploadDest mock 上传文件临时存储的位置
 * 默认为 ./mock/uploads
 * @param {String} options.mockConfigFile 绝对路径 undefined 默认使用当前项目
 * ./mock/.mock.config.js
 * @param {Function} options.mockConfigFormatter 格式化 mockConfigFile 为
 * .mock.config.js 的格式
 */
function createMockMiddleware(options = {}) {
  if (options.mockConfigFile) {
    mockConfigFile = options.mockConfigFile;
  }
  if (options.mockFolder) {
    mockFolder = options.mockFolder;
  }
  if (options.uploadDest) {
    uploadDest = options.uploadDest;
  }
  if (options.mockConfigFormatter) {
    mockConfigFormatter = options.mockConfigFormatter;
  }
  return function(req, res, next) {
    // 只有 mockConfig 配置文件存在才处理
    if (fs.existsSync(mockConfigFile)) {
      // 会创建 ./mock/uploads 文件夹
      // 所以只有 mock 的时候触发
      const uploadBodyParser = multer({ dest: uploadDest });
      // 多个 middleware 一起处理
      composeMiddlewares([
        bodyParser.json(),
        bodyParser.raw(),
        bodyParser.text(),
        bodyParser.urlencoded({ extended: true }),
        uploadBodyParser.any(),
        // mock 需要放在 body 解析之后
        mockMiddleware,
      ])(req, res, next);
    } else {
      next();
    }
  };
}

/**
 * 创建 mock middleware
 * 有两种 mock 方式（后续会逐渐移除老式的 mock 方式）：
 * 1.老式的文件路径 filePathMock 方式（为了兼容，保留这个用法）
 * 2.新的 routerMock 方式，跟 express 的 router 用法一致，推荐使用这种
 * @return express middleware
 */
function mockMiddleware(req, res, next) {
  if (fs.existsSync(uploadDest)) {
    // 清空上传的文件
    fs.emptyDir(uploadDest, err => {
      if (err) return console.error(err);
    });
  }
  let mockConfig;
  try {
    // 删除 mock 配置文件 js require 缓存
    delete require.cache[mockConfigFile];
    // 删除 mock 文件夹的 js require 缓存，可动态 mock 文件夹下的所有 js 文件
    Object.keys(require.cache).forEach(file => {
      if (!!~file.indexOf(mockFolder)) {
        delete require.cache[file];
      }
    });
    mockConfig = mockConfigFormatter(require(mockConfigFile));
  } catch (err) {
    console.log(chalk.red(err.stack));
    next();
    return;
  }

  if (_.isFunction(mockConfig)) {
    // next 在 createMockApp 中处理
    // 这种模式只有 routerMock
    const mockApp = new createMockApp(req, res, next);
    mockConfig(mockApp.getMockApp());
    mockApp.run();
  } else {
    // 兼容模式 .mock.config.js 结构
    // 后续会移除，可以不理会
    // module.exports = {
    //   filePathMock: {
    //     '/keeper/v1/([^?#]*)': '/mock/$1.json',
    //   },
    //   routerMock: function(app){},
    // };
    const nextWithFilePathMock = function() {
      // 默认运行 next
      let shouldRunNext = true;
      // 匹配到 routerMock 则不再运行 filePathMock
      if (mockConfig.filePathMock) {
        // 兼容旧文件路径 mock 模式
        shouldRunNext = createFilePathMock(mockConfig.filePathMock, mockFolder)(req, res);
      }
      if (shouldRunNext) {
        next();
      }
    };
    if (mockConfig.routerMock) {
      // routerPathMock 优先级更高
      const mockApp = new createMockApp(req, res, nextWithFilePathMock);
      mockConfig.routerMock(mockApp.getMockApp());
      mockApp.run();
    } else {
      nextWithFilePathMock();
    }
  }
}

const cache = {};
const cacheLimit = 10000;
let cacheCount = 0;

class createMockApp {
  constructor(req, res, next) {
    this.result = [];
    this.req = req;
    this.res = this.getRewritedRes(res);
    this.next = next;
    // 是否
    this.hasMatched = false;
  }
  /**
   * 重写 res.json res.jsonp res.send，如果是 plain object 则使用 mockjs 处理
   * @param {Object} res express response 对象
   * @returns {Object} res
   */
  getRewritedRes(res) {
    function rewritelWithMockJs(method) {
      const tempResMethod = res[method].bind(res);
      res[method] = function(body) {
        if (_.isPlainObject(body)) {
          body = mockjs.mock(body);
        }
        tempResMethod(body);
      };
    }
    rewritelWithMockJs('json');
    rewritelWithMockJs('jsonp');
    rewritelWithMockJs('send');
    return res;
  }

  getMockApp() {
    const method = this.method;
    // 不支持 options 和 head
    return {
      all: method.bind(this, 'any'),
      get: method.bind(this, 'GET'),
      delete: method.bind(this, 'DELETE'),
      post: method.bind(this, 'POST'),
      put: method.bind(this, 'PUT'),
      patch: method.bind(this, 'PATCH'),
    };
  }

  compilePath(path, options) {
    const cacheKey = `${options.end}${options.strict}${options.sensitive}`;
    const pathCache = cache[cacheKey] || (cache[cacheKey] = {});

    if (pathCache[path]) return pathCache[path];

    const keys = [];
    const regexp = pathToRegexp(path, keys, options);
    const result = { regexp, keys };

    if (cacheCount < cacheLimit) {
      pathCache[path] = result;
      cacheCount++;
    }

    return result;
  }
  /**
   *
   * @param {String} method GET POST DELETE PUT PATCH
   * @param {String} path mock 路由路径配置
   */
  use(method, path, callback) {
    if (!_.isFunction(callback)) {
      throw new TypeError('Expected the callback to be a funciton.');
    }
    const { regexp, keys } = this.compilePath(path, {
      end: true,
      strict: false,
      sensitive: true,
    });
    const match = regexp.exec(this.req.url);

    if (!match || this.hasMatched) {
      return;
    }
    // console.log(match, this.hasMatched, regexp, this.req.url.slice(1));
    this.hasMatched = true;
    // eslint-disable-next-line
    const [noop, ...values] = match;
    this.req.params = keys.reduce((memo, key, index) => {
      memo[key.name] = values[index];
      return memo;
    }, {});
    callback.method = method;
    return callback;
  }
  method(method = 'GET', ...args) {
    this.result.push(this.use(method, ...args));
  }
  run() {
    const req = this.req;
    const res = this.res;
    // 只返回一个匹配的
    const result = this.result.filter(Boolean)[0];
    if (result) {
      if (
        result.method.toLocaleUpperCase() !== req.method.toLocaleUpperCase() &&
        result.method !== 'any'
      ) {
        res.sendStatus(405);
      } else {
        try {
          result(req, res);
        } catch (err) {
          // 语法错误等
          res.status(500).send(err.stack);
        }
      }
    } else {
      this.next();
    }
  }
}

/**
 * 文件路径 mock 方式，这是老式 mock 方式（支持 mockjs 格式）
 * 包括静态文件 .json，和动态文件 .js 的mock 方式
 * @param { Object } filePathMockConfig 格式如下
 * {
 *   '/keeper/v1/([^?#]*)': '/mock/$1.json',
 *   '/keeper/v2/([^?#]*)': '/mock/$1.json',
 * }
 * @param { String } filePathMockConfig[mockRule] mock规则，可以使正则表达式
 * eg. '/keeper/v2/([^?#]*)'
 * @param { String } filePathMockConfig[moackTarget] mock 目标路径
 * eg. '/mock/$1.json'
 * @param { String } mockFolder 指定的 mock 文件夹路径
 */
function createFilePathMock(filePathMockConfig, mockFolder) {
  return function(req, res) {
    for (let k in filePathMockConfig) {
      const mockRule = k;
      let mockTargets = filePathMockConfig[k];
      if (_.isString(mockTargets)) {
        mockTargets = [mockTargets];
      }
      let mockRegExp = new RegExp(mockRule);
      try {
        let status = 200;
        let targetPath;
        let match = req.url.match(mockRegExp);
        if (!match) {
          return true;
        }
        for (let i = 0; i < mockTargets.length; i++) {
          const mt = mockTargets[i];
          // eslint-disable-next-line
          match.forEach((m, k) => {
            targetPath = mt.replace(`$${k}`, m);
          });
          //mock文件路径
          let mockFilePath = path.join(mockFolder, targetPath);
          if (fs.existsSync(mockFilePath)) {
            let mockContents;
            if (/\.js$/.test(mockFilePath)) {
              // .js 文件
              delete require.cache[mockFilePath];
              mockContents = require(mockFilePath);
            } else {
              // .json 文件
              mockContents = fs.readFileSync(mockFilePath, {
                encoding: 'utf-8',
              });
            }
            if (_.isFunction(mockContents)) {
              mockContents = mockContents(req, res);
            }
            if (_.isString(mockContents) && mockContents !== '') {
              try {
                mockContents = JSON.parse(mockContents);
              } catch (e) {
                /**noop**/
              }
            }
            if (!mockContents || mockContents === '') {
              mockContents = {};
            }
            if (_.isPlainObject(mockContents)) {
              mockContents = mockjs.mock(mockContents);
            }
            res.status(status).send(mockContents);
            return false;
          }
        }
        // 没有返回就默认为 404
        res.status(404).send(req.url + ' not found.');
        return false;
      } catch (e) {
        res.status(500).send(e.toString());
        return false;
      }
    }
    return true;
  };
}

module.exports = createMockMiddleware;
