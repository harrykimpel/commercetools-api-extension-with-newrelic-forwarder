var https = require('https');
var url = require('url');
var zlib = require('zlib');

// Global constants
const NR_INSERT_KEY = process.env.NR_INSERT_KEY;
const NR_ENDPOINT = process.env.NR_ENDPOINT;
const NR_MAX_RETRIES = process.env.NR_MAX_RETRIES || 3;
const NR_RETRY_INTERVAL = process.env.NR_RETRY_INTERVAL || 2000; // default: 2 seconds

module.exports = async function (context, req) {
    // Reject a cart that orders more than 10 items
    var cart = req.body.resource.obj;
    var itemsTotal = cart.lineItems.reduce((acc, curr) => {
        return acc + curr.quantity;
    }, 0);

    if (itemsTotal <= 10) {
        context.res = {
            status: 200,
            body: undefined
        };

        await forwardToNewRelic(cart, context);
    }
    else {
        context.res = {
            status: 400,
            body: {
                errors: [{
                    code: "InvalidInput",
                    message: "You can not put more than 10 items into the cart."
                }]
            }
        };
    }

    context.done();
};

function compressData(data) {
    return new Promise((resolve, reject) => {
        zlib.gzip(data, (e, compressedData) => {
            if (!e) {
                resolve(compressedData);
            } else {
                reject({ error: e, res: null });
            }
        });
    });
}

async function forwardToNewRelic(payload, context) {
    try {
        //context.log('payload: ',JSON.stringify(payload));
        nrData = []

        payload.lineItems.forEach(lineItem => {
            lineItemData = {
                eventType: 'sunrise' + payload.type,
                cartId: payload.id,
                cartCustomerId: payload.customerId,
                cartTotalPrice: payload.totalPrice.centAmount,
                cartProduct: JSON.stringify(lineItem.name.en),
                cartProductQuantity: lineItem.quantity,
                cartProductPrice: lineItem.price.value.centAmount,
                cartCountry: payload.country
            };

            //context.log('line item: ', JSON.stringify(lineItemData));
            nrData.push(lineItemData)
        });
        compressedPayload = await compressData(JSON.stringify(nrData));
        try {
            await retryMax(httpSend, NR_MAX_RETRIES, NR_RETRY_INTERVAL, [
                compressedPayload,
                context,
            ]);
            context.log('Logs payload successfully sent to New Relic');
        } catch (e) {
            context.log.error(
                'Max retries reached: failed to send logs payload to New Relic'
            );
            context.log.error('Exception: ', JSON.stringify(e));
        }
    } catch (e) {
        context.log.error('Error during payload compression');
        context.log.error('Exception: ', JSON.stringify(e));
    }
}

function httpSend(data, context) {
    return new Promise((resolve, reject) => {
        const urlObj = url.parse(NR_ENDPOINT);
        const options = {
            hostname: urlObj.hostname,
            port: 443,
            path: urlObj.pathname,
            protocol: urlObj.protocol,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Encoding': 'gzip',
                'X-Insert-Key': NR_INSERT_KEY
            },
        };

        var req = https.request(options, (res) => {
            var body = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => {
                body += chunk; // don't really do anything with body
            });
            res.on('end', () => {
                context.log('Got response:' + res.statusCode);
                if (res.statusCode === 200) {
                    resolve(body);
                } else {
                    reject({ error: null, res: res });
                }
            });
        });

        req.on('error', (e) => {
            context.log('ex:', JSON.stringify(e))
            reject({ error: e, res: null });
        });
        req.write(data);
        req.end();
    });
}

/**
 * Retry with Promise
 * fn: the function to try
 * retry: the number of retries
 * interval: the interval in millisecs between retries
 * fnParams: list of params to pass to the function
 * @returns A promise that resolves to the final result
 */
function retryMax(fn, retry, interval, fnParams) {
    return fn.apply(this, fnParams).catch((err) => {
        return retry > 1
            ? wait(interval).then(() => retryMax(fn, retry - 1, interval, fnParams))
            : Promise.reject(err);
    });
}

function wait(delay) {
    return new Promise((fulfill) => {
        setTimeout(fulfill, delay || 0);
    });
}

