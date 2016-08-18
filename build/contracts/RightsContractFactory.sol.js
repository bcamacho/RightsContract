var Web3 = require("web3");

(function() {
  // Planned for future features, logging, etc.
  function Provider(provider) {
    this.provider = provider;
  }

  Provider.prototype.send = function() {
    this.provider.send.apply(this.provider, arguments);
  };

  Provider.prototype.sendAsync = function() {
    this.provider.sendAsync.apply(this.provider, arguments);
  };

  var BigNumber = (new Web3()).toBigNumber(0).constructor;

  var Utils = {
    is_object: function(val) {
      return typeof val == "object" && !Array.isArray(val);
    },
    is_big_number: function(val) {
      if (typeof val != "object") return false;

      // Instanceof won't work because we have multiple versions of Web3.
      try {
        new BigNumber(val);
        return true;
      } catch (e) {
        return false;
      }
    },
    merge: function() {
      var merged = {};
      var args = Array.prototype.slice.call(arguments);

      for (var i = 0; i < args.length; i++) {
        var object = args[i];
        var keys = Object.keys(object);
        for (var j = 0; j < keys.length; j++) {
          var key = keys[j];
          var value = object[key];
          merged[key] = value;
        }
      }

      return merged;
    },
    promisifyFunction: function(fn, C) {
      var self = this;
      return function() {
        var instance = this;

        var args = Array.prototype.slice.call(arguments);
        var tx_params = {};
        var last_arg = args[args.length - 1];

        // It's only tx_params if it's an object and not a BigNumber.
        if (Utils.is_object(last_arg) && !Utils.is_big_number(last_arg)) {
          tx_params = args.pop();
        }

        tx_params = Utils.merge(C.class_defaults, tx_params);

        return new Promise(function(accept, reject) {
          var callback = function(error, result) {
            if (error != null) {
              reject(error);
            } else {
              accept(result);
            }
          };
          args.push(tx_params, callback);
          fn.apply(instance.contract, args);
        });
      };
    },
    synchronizeFunction: function(fn, C) {
      var self = this;
      return function() {
        var args = Array.prototype.slice.call(arguments);
        var tx_params = {};
        var last_arg = args[args.length - 1];

        // It's only tx_params if it's an object and not a BigNumber.
        if (Utils.is_object(last_arg) && !Utils.is_big_number(last_arg)) {
          tx_params = args.pop();
        }

        tx_params = Utils.merge(C.class_defaults, tx_params);

        return new Promise(function(accept, reject) {

          var callback = function(error, tx) {
            if (error != null) {
              reject(error);
              return;
            }

            var timeout = C.synchronization_timeout || 240000;
            var start = new Date().getTime();

            var make_attempt = function() {
              C.web3.eth.getTransactionReceipt(tx, function(err, receipt) {
                if (err) return reject(err);

                if (receipt != null) {
                  return accept(tx, receipt);
                }

                if (timeout > 0 && new Date().getTime() - start > timeout) {
                  return reject(new Error("Transaction " + tx + " wasn't processed in " + (timeout / 1000) + " seconds!"));
                }

                setTimeout(make_attempt, 1000);
              });
            };

            make_attempt();
          };

          args.push(tx_params, callback);
          fn.apply(self, args);
        });
      };
    }
  };

  function instantiate(instance, contract) {
    instance.contract = contract;
    var constructor = instance.constructor;

    // Provision our functions.
    for (var i = 0; i < instance.abi.length; i++) {
      var item = instance.abi[i];
      if (item.type == "function") {
        if (item.constant == true) {
          instance[item.name] = Utils.promisifyFunction(contract[item.name], constructor);
        } else {
          instance[item.name] = Utils.synchronizeFunction(contract[item.name], constructor);
        }

        instance[item.name].call = Utils.promisifyFunction(contract[item.name].call, constructor);
        instance[item.name].sendTransaction = Utils.promisifyFunction(contract[item.name].sendTransaction, constructor);
        instance[item.name].request = contract[item.name].request;
        instance[item.name].estimateGas = Utils.promisifyFunction(contract[item.name].estimateGas, constructor);
      }

      if (item.type == "event") {
        instance[item.name] = contract[item.name];
      }
    }

    instance.allEvents = contract.allEvents;
    instance.address = contract.address;
    instance.transactionHash = contract.transactionHash;
  };

  // Use inheritance to create a clone of this contract,
  // and copy over contract's static functions.
  function mutate(fn) {
    var temp = function Clone() { return fn.apply(this, arguments); };

    Object.keys(fn).forEach(function(key) {
      temp[key] = fn[key];
    });

    temp.prototype = Object.create(fn.prototype);
    bootstrap(temp);
    return temp;
  };

  function bootstrap(fn) {
    fn.web3 = new Web3();
    fn.class_defaults  = fn.prototype.defaults || {};

    // Set the network iniitally to make default data available and re-use code.
    // Then remove the saved network id so the network will be auto-detected on first use.
    fn.setNetwork("default");
    fn.network_id = null;
    return fn;
  };

  // Accepts a contract object created with web3.eth.contract.
  // Optionally, if called without `new`, accepts a network_id and will
  // create a new version of the contract abstraction with that network_id set.
  function Contract() {
    if (this instanceof Contract) {
      instantiate(this, arguments[0]);
    } else {
      var C = mutate(Contract);
      var network_id = arguments.length > 0 ? arguments[0] : "default";
      C.setNetwork(network_id);
      return C;
    }
  };

  Contract.currentProvider = null;

  Contract.setProvider = function(provider) {
    var wrapped = new Provider(provider);
    this.web3.setProvider(wrapped);
    this.currentProvider = provider;
  };

  Contract.new = function() {
    if (this.currentProvider == null) {
      throw new Error("RightsContractFactory error: Please call setProvider() first before calling new().");
    }

    var args = Array.prototype.slice.call(arguments);

    if (!this.unlinked_binary) {
      throw new Error("RightsContractFactory error: contract binary not set. Can't deploy new instance.");
    }

    var regex = /__[^_]+_+/g;
    var unlinked_libraries = this.binary.match(regex);

    if (unlinked_libraries != null) {
      unlinked_libraries = unlinked_libraries.map(function(name) {
        // Remove underscores
        return name.replace(/_/g, "");
      }).sort().filter(function(name, index, arr) {
        // Remove duplicates
        if (index + 1 >= arr.length) {
          return true;
        }

        return name != arr[index + 1];
      }).join(", ");

      throw new Error("RightsContractFactory contains unresolved libraries. You must deploy and link the following libraries before you can deploy a new version of RightsContractFactory: " + unlinked_libraries);
    }

    var self = this;

    return new Promise(function(accept, reject) {
      var contract_class = self.web3.eth.contract(self.abi);
      var tx_params = {};
      var last_arg = args[args.length - 1];

      // It's only tx_params if it's an object and not a BigNumber.
      if (Utils.is_object(last_arg) && !Utils.is_big_number(last_arg)) {
        tx_params = args.pop();
      }

      tx_params = Utils.merge(self.class_defaults, tx_params);

      if (tx_params.data == null) {
        tx_params.data = self.binary;
      }

      // web3 0.9.0 and above calls new twice this callback twice.
      // Why, I have no idea...
      var intermediary = function(err, web3_instance) {
        if (err != null) {
          reject(err);
          return;
        }

        if (err == null && web3_instance != null && web3_instance.address != null) {
          accept(new self(web3_instance));
        }
      };

      args.push(tx_params, intermediary);
      contract_class.new.apply(contract_class, args);
    });
  };

  Contract.at = function(address) {
    if (address == null || typeof address != "string" || address.length != 42) {
      throw new Error("Invalid address passed to RightsContractFactory.at(): " + address);
    }

    var contract_class = this.web3.eth.contract(this.abi);
    var contract = contract_class.at(address);

    return new this(contract);
  };

  Contract.deployed = function() {
    if (!this.address) {
      throw new Error("Cannot find deployed address: RightsContractFactory not deployed or address not set.");
    }

    return this.at(this.address);
  };

  Contract.defaults = function(class_defaults) {
    if (this.class_defaults == null) {
      this.class_defaults = {};
    }

    if (class_defaults == null) {
      class_defaults = {};
    }

    var self = this;
    Object.keys(class_defaults).forEach(function(key) {
      var value = class_defaults[key];
      self.class_defaults[key] = value;
    });

    return this.class_defaults;
  };

  Contract.extend = function() {
    var args = Array.prototype.slice.call(arguments);

    for (var i = 0; i < arguments.length; i++) {
      var object = arguments[i];
      var keys = Object.keys(object);
      for (var j = 0; j < keys.length; j++) {
        var key = keys[j];
        var value = object[key];
        this.prototype[key] = value;
      }
    }
  };

  Contract.all_networks = {
  "default": {
    "abi": [
      {
        "constant": true,
        "inputs": [],
        "name": "creator",
        "outputs": [
          {
            "name": "",
            "type": "address"
          }
        ],
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [
          {
            "name": "name",
            "type": "bytes32"
          }
        ],
        "name": "initiateContract",
        "outputs": [],
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [
          {
            "name": "_name",
            "type": "bytes32"
          }
        ],
        "name": "getContractAddr",
        "outputs": [
          {
            "name": "retVal",
            "type": "address"
          }
        ],
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [
          {
            "name": "name",
            "type": "bytes32"
          }
        ],
        "name": "removeContract",
        "outputs": [],
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [],
        "name": "remove",
        "outputs": [],
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [
          {
            "name": "",
            "type": "bytes32"
          }
        ],
        "name": "contracts",
        "outputs": [
          {
            "name": "",
            "type": "address"
          }
        ],
        "type": "function"
      },
      {
        "inputs": [],
        "type": "constructor"
      },
      {
        "anonymous": false,
        "inputs": [
          {
            "indexed": true,
            "name": "_name",
            "type": "bytes32"
          },
          {
            "indexed": true,
            "name": "_addr",
            "type": "address"
          }
        ],
        "name": "RightsContractCreated",
        "type": "event"
      }
    ],
    "unlinked_binary": "0x606060405260008054600160a060020a03191633179055611ac6806100246000396000f3606060405236156100565760e060020a600035046302d05d3f811461005857806304d6b8e31461006a5780631d2cdc3b14610093578063a43e04d8146100c2578063a7f43779146100ee578063ec56a37314610116575b005b6100af600054600160a060020a031681565b610056600435600081815260016020526040812054600160a060020a0316811461013757610002565b600435600090815260016020526040902054600160a060020a03165b600160a060020a03166060908152602090f35b610056600435600081815260016020526040812054600160a060020a031690818114156101ca57610002565b61005660005433600160a060020a03908116911614156102c757600054600160a060020a0316ff5b6100af600435600160205260009081526040902054600160a060020a031681565b60606117fd806102c9833901809050604051809103906000f0905080600160005060008460001916815260200190815260200160002060006101000a815481600160a060020a030219169083021790555080600160a060020a031682600019167f4c72d18f252e354e50c877f95cfb1815fe6b40594916460ac7dc06f4362f336860405180905060405180910390a35050565b7ffcaa76640000000000000000000000000000000000000000000000000000000060609081528291829163fcaa7664916064916020916004908290876161da5a03f115610002575050604051516003141590506102c25780600160a060020a03166383c1cd8a336040518260e060020a0281526004018082600160a060020a031681526020019150506020604051808303816000876161da5a03f1156100025750506040515190508061028c5750600054600160a060020a0390811633909116145b156102c257600160005060008460001916815260200190815260200160002060006101000a815490600160a060020a0302191690555b505050565b5660606040526000805460ff1916815560038190556004556117d9806100246000396000f3606060405236156101695760e060020a600035046310953b45811461016b57806312065fe014610268578063170e944e14610288578063221c94b6146102e45780632607ab20146103815780632f370e47146103ba5780633341b4451461040b57806338b4730e1461047957806342a403e01461052057806349c2a1a6146105c85780634e7d85b8146106d65780635fd8c710146107185780636811d3d9146107755780636dd7d8ea146107905780636e2123ee146107d4578063730bd929146108225780637381389c146108995780637e0b4950146108eb578063815af9081461093a57806383c1cd8a14610972578063898ac3fe1461099a5780639c57c187146109e4578063a783474014610a1e578063b85a35d214610a2c578063c040e6b814610a41578063c1a4224314610a4d578063c522debd14610ad8578063d13319c414610ae3578063d8bff5a514610b4d578063e5afffed14610b6e578063fcaa766414610c15575b005b60408051602060248035600481810135601f81018590048502860185019096528585526101699581359591946044949293909201918190840183828082843750506040805160209735808a0135601f81018a90048a0283018a01909352828252969897606497919650602491909101945090925082915084018382808284375094965050933593505050506040805160a0810182526000608082018181528252825160208181018552828252838101919091528284018290526060830182905233600160a060020a0316825260019052919091205460ff1615610f52576000805460ff161415610f525760055460649083011115610cd457610002565b610c2333600160a060020a03166000908152600860205260409020545b90565b610c355b600080805b600354811015610f595760028054600791600091849081101561000257506000805160206117b9833981519152840154600160a060020a0316825260209290925260409020015490910190600101610291565b6040805160206004803580820135601f8101849004840285018401909552848452610169949193602493909291840191908190840183828082843750506040805160208835808b0135601f8101839004830284018301909452838352979998604498929750919091019450909250829150840183828082843750949650505050505050600b5460009081908190819060ff161515610f8057610002565b61016933600160a060020a031660009081526001602052604081205460ff161561110457805460ff1660031415611104576110a161028c565b610c356004356000600760005060006002600050848154811015610002575050506000805160206117b9833981519152830154600160a060020a03168252602052604090206003015460ff16610995565b610c496004356009602090815260009182526040918290208054835160026001831615610100026000190190921691909104601f81018490048402820184019094528381529290918301828280156111325780601f1061110757610100808354040283529160200191611132565b610c4960043560408051602081019091526000808252600280546007929190859081101561000257506000805160206117b9833981519152850154600160a060020a031682526020928352604091829020805483516001821615610100026000190190911692909204601f810185900485028301850190935282825290929091908301828280156111655780601f1061113a57610100808354040283529160200191611165565b610c4960043560408051602081019091526000808252600280546007929190859081101561000257506000805160206117b9833981519152850154600160a060020a0316825260209283526040918290206001908101805484519281161561010002600019011692909204601f8101859004850282018501909352828152929091908301828280156111655780601f1061113a57610100808354040283529160200191611165565b6040805160206004803580820135601f810184900484028501840190955284845261016994919360249390929184019190819084018382808284375094965050505050505033600160a060020a031660009081526001602052604081205460ff1615611174575b6003548110156111785733600160a060020a0316600a60005060006002600050848154811015610002576000805160206117b98339815191520154600160a060020a0390811683526020939093525060409020541614156106ce5760028054600a916000918490811015610002576000805160206117b98339815191520154600160a060020a0316825250604090208054600160a060020a0319169055505b60010161062f565b61016933600160a060020a031660009081526001602052604090205460ff1615610716576000805460ff199081166003178255600b805490911690556004555b565b61016933600160a060020a031660009081526001602052604081205460ff161561110457600860205260408082208054908390559051909133600160a060020a031691839082818181858883f19350505050151561110457610002565b610c3560043560016020526000908152604090205460ff1681565b61016960043533600160a060020a031660009081526001602052604090205460ff161561110457600a60205260406000208054600160a060020a0319168217905550565b61016933600160a060020a031660009081526001602052604090205460ff16156107165760005460ff16600114156107165760005460ff166003146107165760055460641461121357610002565b610c235b60008080808080805b6003548310156112225760028054600a916000918690811015610002576000805160206117b98339815191520154600160a060020a0390811683526020938452604080842054909116808452938a905290912080546001908101909155949094019350915061082f565b610cb76004356000600a60005060006002600050848154811015610002575050506000805160206117b9833981519152830154600160a060020a03908116835260209190915260409091205416610995565b610c23600435600060076000506000600260005084815481101561000257506000805160206117b9833981519152850154600160a060020a031690915260209190915260409091200154610995565b61016933600160a060020a031660009081526001602052604081205460ff161561110457805460ff16811415611104576112de61028c565b610c35600435600160a060020a03811660009081526001602052604090205460ff165b919050565b61016933600160a060020a0316600090815260016020526040812054819060ff161561117457805460ff166002148015906109da5750805460ff16600114155b1561133c57610002565b610cb760043560006002600050828154811015610002575090526000805160206117b9833981519152810154600160a060020a0316610995565b610c35600b5460ff16610285565b6101696004356003546000146114b157610002565b610c2360005460ff1681565b6101696004356000610c80604051908101604052806064905b6000815260200190600190039081610a6657505033600160a060020a031660009081526001602052604081205481908190819060ff161561177957805460ff1681141561177957600160a060020a0387168152604081205460ff161580610ace575060035481145b156114d857610002565b610c23600354610285565b60408051602081810183526000825260068054845160026001831615610100026000190190921691909104601f8101849004840282018401909552848152610c499490928301828280156117ad5780601f10611782576101008083540402835291602001916117ad565b610cb7600435600a60205260009081526040902054600160a060020a031681565b610c4960043560408051602081019091526000808252600280546009929190859081101561000257506000805160206117b9833981519152850154600160a060020a031682526020928352604091829020805483516101006001831615026000190190911692909204601f810185900485028301850190935282825290929091908301828280156111655780601f1061113a57610100808354040283529160200191611165565b610c2360005460ff16610285565b60408051918252519081900360200190f35b604080519115158252519081900360200190f35b60405180806020018281038252838181518152602001915080519060200190808383829060006004602084601f0104600f02600301f150905090810190601f168015610ca95780820380516001836020036101000a031916815260200191505b509250505060405180910390f35b60408051600160a060020a03929092168252519081900360200190f35b50604080516080810182528481526020818101859052818301849052600060608301819052600160a060020a03881681526007825292832082518051825483875295849020949586959394859460026001841615610100026000190190931692909204601f90810182900483019490910190839010610d7657805160ff19168380011785555b50610da69291505b80821115610e055760008155600101610d62565b82800160010185558215610d5a579182015b82811115610d5a578251826000505591602001919060010190610d88565b50506020820151816001016000509080519060200190828054600181600116156101000203166002900490600052602060002090601f016020900481019282601f10610e0957805160ff19168380011785555b50610e39929150610d62565b5090565b82800160010185558215610df9579182015b82811115610df9578251826000505591602001919060010190610e1b565b505060408281015160028381019190915560039290920180546060949094015160ff19948516179055600160a060020a0388166000908152600160208190529190208054909316811790925580549182018082559091908281838015829011610eb557818360005260206000209182019101610eb59190610d62565b50505060009283525060208220018054600160a060020a03191687179055600580548401905560038054600101905560045414610f5257610f525b60005b600354811015611104576000600760005060006002600050848154811015610002575050506000805160206117b9833981519152830154600160a060020a0316825260205260408120600301805460ff19169055600455600101610ef3565b5050505050565b8160641480610f685750816000145b15610f765760019250610f7b565b600092505b505090565b349350600092505b600354831015610ffa5760028054849081101561000257506000805160206117b9833981519152840154600160a060020a031660008181526007602090815260408083209094015460089091529290208054606490930487029283019055948101946001949094019392509050610f88565b84604051808280519060200190808383829060006004602084601f0104600f02600301f150905001915050604051809103902086604051808280519060200190808383829060006004602084601f0104600f02600301f150905001915050604051809103902033600160a060020a03167ffc71ca374d789cccc9fb9258741cd962692a685bbb38110ecaec13732506fe9760405180905060405180910390a4505050505050565b15806110c8575033600160a060020a031660009081526007602052604090206003015460ff165b156110d257610002565b50600480546001810190915560035403600019016000811415611104576000805460ff19168155600455611104610ef0565b50565b820191906000526020600020905b81548152906001019060200180831161111557829003601f168201915b505050505081565b820191906000526020600020905b81548152906001019060200180831161114857829003601f168201915b50505050509050610995565b50505b5050565b33600160a060020a0316600090815260096020908152604082208451815482855293839020919360026001821615610100026000190190911604601f9081018490048301939192918701908390106111e357805160ff19168380011785555b50611171929150610d62565b828001600101855582156111d7579182015b828111156111d75782518260005055916020019190600101906111f5565b600b805460ff19166001179055565b5060005b6003548110156112ba57838660006002600050848154811015610002576000805160206117b98339815191520154600160a060020a0316825250602091909152604090205411156112b2578560006002600050838154811015610002576000805160206117b98339815191520154600160a060020a031682525060209190915260409020549094509250835b600101611226565b600354600290048411156112d0578496506112d5565b606596505b50505050505090565b1580611305575033600160a060020a031660009081526007602052604090206003015460ff165b1561130f57610002565b50600480546001810190915560035403600019016000811415611104576000805460ff1916600117905550565b611344610826565b9150816065141561135457610002565b60028054600991600091859081101561000257506000805160206117b9833981519152850154600160a060020a0316825260209283526040822080546006805494819052947ff652222313e28459528d920b65115c16c04f3efc82aaedc97be59f3f377c0d3f600186811615610100908102600019908101909816879004601f90810194909404830197918516150201909216939093049290919083901061140757805485555b50611443929150610d62565b828001600101855582156113fb57600052602060002091601f016020900482015b828111156113fb578254825591600101919060010190611428565b50506000805460ff1916600217815590505b6003548110156111745760028054600a9160009184908110156100025750506000805160206117b9833981519152830154600160a060020a03168152602091909152604090208054600160a060020a0319169055600101611455565b600160a060020a03166000908152600160208190526040909120805460ff19169091179055565b600354600160a060020a0388166000908152600160208181526040808420805460ff191690556007909152822080548382556000199485019a50909384926002908316156101000290910190911604601f81901061160857505b5060018201600050805460018160011615610100020316600290046000825580601f1061162657505b5050600060028201819055600391909101805460ff1916905592505b60035483101561164a5786600160a060020a0316600260005084815481101561000257506000526000805160206117b9833981519152840154600160a060020a031614611644576002805484908110156100025750506000805160206117b9833981519152830154600160a060020a0316858460648110156100025750506020840286015260019290920191611577565b601f0160209004906000526020600020908101906115329190610d62565b601f01602090049060005260206000209081019061155b9190610d62565b82935083505b8391505b858210156116b75760028054600184019081101561000257506000527f405787fa12a823e0f2b7631cc41b3ba8828b3321ca811111fa75cd3aa3bb5acf820154600160a060020a031685836064811015610002575050602083028601526001919091019061164e565b600280546000808355919091526116e0906000805160206117b983398151915290810190610d62565b50600090505b8581101561171e576002805460018101808355828183801582901161173a5781836000526020600020918201910161173a9190610d62565b6003805460001901905560045460001461177957611779610ef0565b5050509190906000526020600020900160008784606481101561000257505050602083028701518154600160a060020a031916179055506001016116e6565b50505050505050565b820191906000526020600020905b81548152906001019060200180831161179057829003601f168201915b5050505050905061028556405787fa12a823e0f2b7631cc41b3ba8828b3321ca811111fa75cd3aa3bb5ace",
    "updated_at": 1471550263101,
    "links": {},
    "address": "0x565e8ebcb79db5359afb4d55dcbe04b422474e0a"
  }
};

  Contract.checkNetwork = function(callback) {
    var self = this;

    if (this.network_id != null) {
      return callback();
    }

    this.web3.version.network(function(err, result) {
      if (err) return callback(err);

      var network_id = result.toString();

      // If we have the main network,
      if (network_id == "1") {
        var possible_ids = ["1", "live", "default"];

        for (var i = 0; i < possible_ids.length; i++) {
          var id = possible_ids[i];
          if (Contract.all_networks[id] != null) {
            network_id = id;
            break;
          }
        }
      }

      if (self.all_networks[network_id] == null) {
        return callback(new Error(self.name + " error: Can't find artifacts for network id '" + network_id + "'"));
      }

      self.setNetwork(network_id);
      callback();
    })
  };

  Contract.setNetwork = function(network_id) {
    var network = this.all_networks[network_id] || {};

    this.abi             = this.prototype.abi             = network.abi;
    this.unlinked_binary = this.prototype.unlinked_binary = network.unlinked_binary;
    this.address         = this.prototype.address         = network.address;
    this.updated_at      = this.prototype.updated_at      = network.updated_at;
    this.links           = this.prototype.links           = network.links || {};

    this.network_id = network_id;
  };

  Contract.networks = function() {
    return Object.keys(this.all_networks);
  };

  Contract.link = function(name, address) {
    if (typeof name == "object") {
      Object.keys(name).forEach(function(n) {
        var a = name[n];
        Contract.link(n, a);
      });
      return;
    }

    Contract.links[name] = address;
  };

  Contract.contract_name   = Contract.prototype.contract_name   = "RightsContractFactory";
  Contract.generated_with  = Contract.prototype.generated_with  = "3.1.2";

  var properties = {
    binary: function() {
      var binary = Contract.unlinked_binary;

      Object.keys(Contract.links).forEach(function(library_name) {
        var library_address = Contract.links[library_name];
        var regex = new RegExp("__" + library_name + "_*", "g");

        binary = binary.replace(regex, library_address.replace("0x", ""));
      });

      return binary;
    }
  };

  Object.keys(properties).forEach(function(key) {
    var getter = properties[key];

    var definition = {};
    definition.enumerable = true;
    definition.configurable = false;
    definition.get = getter;

    Object.defineProperty(Contract, key, definition);
    Object.defineProperty(Contract.prototype, key, definition);
  });

  bootstrap(Contract);

  if (typeof module != "undefined" && typeof module.exports != "undefined") {
    module.exports = Contract;
  } else {
    // There will only be one version of this contract in the browser,
    // and we can use that.
    window.RightsContractFactory = Contract;
  }
})();
