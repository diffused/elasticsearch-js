describe('Http Connector', function () {

  var should = require('should');
  var Host = require('../../src/lib/host');
  var errors = require('../../src/lib/errors');
  var HttpConnection = require('../../src/lib/connectors/http');
  var ConnectionAbstract = require('../../src/lib/connection');
  var nock = require('nock');
  var sinon = require('sinon');
  var util = require('util');

  var http = require('http');
  var https = require('https');

  var MockRequest = require('../mocks/request');
  var MockIncommingMessage = require('../mocks/incomming_message');

  nock.disableNetConnect();

  var stub = require('./auto_release_stub').make();

  function makeStubReqMethod(prep) {
    return function (params, cb) {
      var req = new MockRequest();
      if (prep) {
        prep(req, params, cb);
      }
      return req;
    };
  }

  function whereReqDies(withErr) {
    return function (req) {
      process.nextTick(function () {
        // causes the request to quit and callback
        req.emit('error', withErr || void 0);
      });
    };
  }

  describe('Constructor', function () {
    it('creates an object that extends ConnectionAbstract', function () {
      var con = new HttpConnection(new Host());
      con.should.be.an.instanceOf(ConnectionAbstract);
    });

    it('sets certain defaults', function () {
      var con = new HttpConnection(new Host());

      con.hand.should.be.exactly(require('http'));
      // con.requestTimeout
      // maxSockets
      // maxFreeSockets
      // maxKeepAliveTime
      // requestTimeout
    });

    it('expects one the host to have a protocol of http or https', function () {
      (function () {
        var con = new HttpConnection(new Host('thrifty://es.com/stuff'));
      }).should.throw(/invalid protocol/i);
    });
  });

  describe('#makeReqParams', function () {
    it('properly reads the host object', function () {
      var host = new Host('john:dude@pizza.com:9200/pizza/cheese?shrooms=true');
      var con = new HttpConnection(host, {});
      var reqParams = con.makeReqParams();

      reqParams.should.eql({
        method: 'GET',
        protocol: 'http:',
        auth: 'john:dude',
        hostname: 'pizza.com',
        port: 9200,
        path: '/pizza/cheese?shrooms=true',
        headers: host.headers,
        agent: con.agent
      });
    });

    it('merges a query object with the hosts\'', function () {
      var con = new HttpConnection(new Host({
        query: {
          user_id: 123
        }
      }));

      var reqParams = con.makeReqParams({
        query: {
          jvm: 'yes'
        }
      });

      reqParams.should.include({
        path: '/?user_id=123&jvm=yes'
      });
    });

    it('merges the path prefex', function () {
      var con = new HttpConnection(new Host('https://google.com/path/prefix/for/user/1'));
      var reqParams = con.makeReqParams({
        method: 'GET',
        path: '/items',
        query: {
          q: 'pizza'
        }
      });

      reqParams.should.eql({
        method: 'GET',
        protocol: 'https:',
        auth: null,
        hostname: 'google.com',
        port: 443,
        path: '/path/prefix/for/user/1/items?q=pizza',
        headers: undefined,
        agent: con.agent
      });
    });

    it('merges the query', function () {
      var con = new HttpConnection(new Host('http://google.com/pref-x?userId=12345&token=42069'));

      var reqParams = con.makeReqParams({
        method: 'PUT',
        path: '/stuff',
        query: {
          q: 'pizza'
        }
      });

      reqParams.should.eql({
        method: 'PUT',
        protocol: 'http:',
        auth: null,
        hostname: 'google.com',
        port: 80,
        path: '/pref-x/stuff?userId=12345&token=42069&q=pizza',
        headers: undefined,
        agent: con.agent
      });
    });

    it('Works well with minimum params', function () {
      var con = new HttpConnection(new Host('http://google.com'));

      var reqParams = con.makeReqParams({
        method: 'PUT',
        path: '/stuff'
      });

      reqParams.should.eql({
        method: 'PUT',
        protocol: 'http:',
        auth: null,
        hostname: 'google.com',
        port: 80,
        path: '/stuff',
        headers: undefined,
        agent: con.agent
      });
    });
  });

  describe('#request', function () {
    beforeEach(function () {
      stub(http, 'request', makeStubReqMethod(whereReqDies()));
      stub(https, 'request', makeStubReqMethod(whereReqDies()));
    });

    it('calls http based on the host', function (done) {
      var con = new HttpConnection(new Host('http://google.com'));
      con.request({}, function () {
        http.request.callCount.should.eql(1);
        https.request.callCount.should.eql(0);
        done();
      });
    });

    it('calls https based on the host', function (done) {
      var con = new HttpConnection(new Host('https://google.com'));
      con.request({}, function () {
        http.request.callCount.should.eql(0);
        https.request.callCount.should.eql(1);
        done();
      });
    });

    it('does not log error events', function (done) {
      var con = new HttpConnection(new Host('http://google.com'));

      stub(con.log, 'error');
      stub(con.log, 'trace');
      stub(con.log, 'info');
      stub(con.log, 'warning');
      stub(con.log, 'debug');

      http.request.restore();
      stub(http, 'request', makeStubReqMethod(whereReqDies(new Error('actual error'))));

      con.request({}, function (err) {
        // error should have been sent to the
        err.message.should.eql('actual error');

        // logged the error and the trace log
        con.log.trace.callCount.should.eql(1);
        con.log.error.callCount.should.eql(0);
        con.log.info.callCount.should.eql(0);
        con.log.warning.callCount.should.eql(0);
        con.log.debug.callCount.should.eql(0);

        done();
      });
    });

    it('logs error events', function (done) {
      var con = new HttpConnection(new Host('http://google.com'));

      stub(con.log, 'error');

      http.request.func = makeStubReqMethod(whereReqDies(new Error('actual error')));

      con.request({}, function (err) {
        // error should have been sent to the
        err.message.should.eql('actual error');

        // logged the error
        con.log.error.callCount.should.eql(0);
        done();
      });
    });
  });

  describe('#request with incomming message error', function () {
    function makeStubReqWithMsgWhichErrorsMidBody(err) {
      return makeStubReqMethod(function (req, params, cb) {
        process.nextTick(function () {
          var incom = new MockIncommingMessage();
          incom.statusCode = 200;
          setTimeout(function () {
            incom.emit('data', '{ "not json"');
            incom.emit('error', err || new Error('Socket is dead now...'));
          }, 20);
          cb(incom);
        });
      });
    }

    it('does not log errors', function (done) {
      var con = new HttpConnection(new Host('https://google.com'));
      stub(con.log, 'error');
      stub(https, 'request', makeStubReqWithMsgWhichErrorsMidBody());

      con.request({}, function (err, resp, status) {
        con.log.error.callCount.should.eql(0);
        done();
      });
    });

    it('passes the original error on', function (done) {
      var con = new HttpConnection(new Host('https://google.com'));
      stub(https, 'request', makeStubReqWithMsgWhichErrorsMidBody(new Error('no more message :(')));

      con.request({}, function (err, resp, status) {
        should.exist(err);
        err.message.should.eql('no more message :(');
        done();
      });
    });

    it('does not pass the partial body along', function (done) {
      var con = new HttpConnection(new Host('https://google.com'));
      stub(https, 'request', makeStubReqWithMsgWhichErrorsMidBody());

      con.request({}, function (err, resp, status) {
        should.not.exist(resp);
        done();
      });
    });

    it('does not pass the status code along', function (done) {
      var con = new HttpConnection(new Host('https://google.com'));
      stub(https, 'request', makeStubReqWithMsgWhichErrorsMidBody());

      con.request({}, function (err, resp, status) {
        should.not.exist(status);
        done();
      });
    });
  });

  describe('#request\'s responder', function () {
    it('collects the whole request body', function (done) {
      var server = nock('http://esjs.com:9200');
      var con = new HttpConnection(new Host('http://esjs.com:9200'));
      var body = '{ "USER": "doc" }';

      server
        .get('/users/1')
        .reply(200, body);

      con.request({
        method: 'GET',
        path: '/users/1'
      }, function (err, resp, status) {
        should.not.exist(err);
        resp.should.eql(body);
        status.should.eql(200);
        server.done();
        done();
      });
    });

    it('Ignores serialization errors', function (done) {
      var server = nock('http://esjs.com:9200');
      var con = new HttpConnection(new Host('http://esjs.com:9200'));
      var body = '{ "USER":';

      // partial body
      server
        .get('/users/1')
        .reply(200, body);

      con.request({
        method: 'GET',
        path: '/users/1'
      }, function (err, resp, status) {
        should.not.exist(err);
        resp.should.eql(body);
        status.should.eql(200);
        done();
      });
    });
  });

  describe('HTTP specifics', function () {
    it('uses TCP no delay', function (done) {
      var con = new HttpConnection(new Host('localhost'));
      stub(http.ClientRequest.prototype, 'setNoDelay');
      var server = nock('http://localhost').get('/').reply(200);

      con.request({}, function (err, resp, status) {
        http.ClientRequest.prototype.setNoDelay.callCount.should.eql(1);
        http.ClientRequest.prototype.setNoDelay.lastCall.args[0].should.eql(true);
        server.done();
        done();
      });
    });

    it('sets the Content-Length header properly', function (done) {
      var con = new HttpConnection(new Host('localhost'));
      stub(http.ClientRequest.prototype, 'setHeader');
      var server = nock('http://localhost').get('/').reply(200);

      var body = 'pasta and 𝄞';
      body.length.should.eql(12); // nope
      Buffer.byteLength(body, 'utf8').should.eql(14); // yep

      con.request({
        body: body
      }, function (err, resp, status) {
        http.ClientRequest.prototype.setHeader.lastCall.args.should.eql(['Content-Length', 14]);
        server.done();
        done();
      });
    });
  });

});
