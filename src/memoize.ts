/**
 * Decorates a property or accessor with a memoization. By default it memoizes
 * based on a strict equality check of the function's first parameter. Inspired
 * by: https://gist.github.com/dsherret/cbe661faf7e3cfad8397
 */
export function Memoize(hasher: (...args: any[]) => any = value => value) { // tslint:disable-line
    return (_target: any, _prop: string, descriptor: TypedPropertyDescriptor<any>) => {
        if (descriptor.value != null) {
            descriptor.value = getNewFunction<any, any>(hasher, descriptor.value);
        } else if (descriptor.get != null) {
            descriptor.get = getNewFunction<any, any>(hasher, descriptor.get);
        } else {
            throw new Error('Can only attach @Memoize() to methods and property getters');
        }
    };
}

const recordsSymbol = Symbol('memoized records');
const funcIdSymbol = Symbol('unique memoized function id');

/**
 * Clears memoized values for a function on the provided object instance.
 */
export function forget(instance: any, func: Function) {
    const id: string = (<any> func)[funcIdSymbol];
    if (!id) {
        throw new Error('Cannot forget a function that is non memoized!');
    }
    if (!instance[recordsSymbol]) {
        return;
    }

    delete instance[recordsSymbol][id];
}

let funcIdCounter = 0;

/* tslint:disable:no-invalid-this */
function getNewFunction<T, R>(
    hasher: (...args: any[]) => T,
    originalFunction: (...args: any[]) => R,
) {
    const id = funcIdCounter;
    funcIdCounter++;

    const func = function(this: any) {
        let records: { [key: string]: Map<T, R> } = this[recordsSymbol];
        if (!records) {
            records = this[recordsSymbol] = Object.create(null);
        }

        let results = records[id];
        if (!results) {
            results = records[id] = new Map();
        }

        const hashKey = hasher.apply(this, arguments);
        if (results.has(hashKey)) {
            return results.get(hashKey);
        }

        const result = originalFunction.apply(this, arguments);
        results.set(hashKey, result);
        return result;
    };

    return Object.assign(func, { [funcIdSymbol]: id });
}
