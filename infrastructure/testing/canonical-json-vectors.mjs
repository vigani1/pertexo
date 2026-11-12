// Literal golden bytes shared by every encoding consumer. Both profiles are
// persisted contracts; numeric object keys are their only ordering difference.
export const canonicalJsonVectors = [
  {
    name: 'nested containers and array order',
    input: { z: [{ b: 2, a: 1 }, null, false], a: [] },
    ecmascript: '{"a":[],"z":[{"a":1,"b":2},null,false]}',
    lexical: '{"a":[],"z":[{"a":1,"b":2},null,false]}',
  },
  {
    name: 'integer-looking keys',
    input: {
      z: 0,
      10: 'ten',
      2: 'two',
      '00': 'zeroes',
      4294967295: 'name',
      a: { 10: 10, 2: 2 },
    },
    ecmascript:
      '{"2":"two","10":"ten","00":"zeroes","4294967295":"name","a":{"2":2,"10":10},"z":0}',
    lexical:
      '{"00":"zeroes","10":"ten","2":"two","4294967295":"name","a":{"10":10,"2":2},"z":0}',
  },
  {
    name: 'scalar representation',
    input: [-0, 1e-7, 1e21, 0.125, true, null, 'é雪😀\n"\\'],
    ecmascript: '[0,1e-7,1e+21,0.125,true,null,"é雪😀\\n\\"\\\\"]',
    lexical: '[0,1e-7,1e+21,0.125,true,null,"é雪😀\\n\\"\\\\"]',
  },
  {
    name: 'hostile names are own data',
    input: JSON.parse('{"constructor":7,"__proto__":{"b":2,"a":1}}'),
    ecmascript: '{"__proto__":{"a":1,"b":2},"constructor":7}',
    lexical: '{"__proto__":{"a":1,"b":2},"constructor":7}',
  },
];
